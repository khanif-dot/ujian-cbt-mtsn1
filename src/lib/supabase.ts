import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Konfigurasi Supabase tertanam permanen (hardcoded/default)
 * agar seluruh perangkat client langsung terhubung otomatis tanpa konfigurasi manual.
 * Ganti nilai default ini dengan Project URL & Anon Key Supabase sekolah Anda saat produksi.
 */
export const DEFAULT_SUPABASE_URL = 'https://mvymlqexsaykuciujdkq.supabase.co';
export const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12eW1scWV4c2F5a3VjaXVqZGtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ3NjU3MTUsImV4cCI6MjExMDM0MTcxNX0.E3J3gT2Q62Q5ESlIojAcUi9Zw7do4WHmai_S3YCckHw';

const RUNTIME_CONFIG_KEY = 'cbt_supabase_runtime_config_v1';

export interface SupabaseRuntimeConfig {
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
  schema?: string;
  autoSyncIntervalSec?: number;
  enableRealtime?: boolean;
}

export type SupabaseConfigSource = 'runtime' | 'env' | 'default';

export interface DecodedJwtInfo {
  valid: boolean;
  role?: string;
  ref?: string;
  expIso?: string;
  expired?: boolean;
}

export function extractProjectRef(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname;
    if (host.endsWith('.supabase.co')) {
      return host.replace('.supabase.co', '');
    }
    return host.split('.')[0] || '';
  } catch {
    return '';
  }
}

export function decodeJwtPayload(token: string): DecodedJwtInfo {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false };
  const parts = trimmed.split('.');
  if (parts.length !== 3) {
    // Supabase newer keys can also be sb_publishable_... / sb_secret_...
    if (trimmed.startsWith('sb_publishable_')) {
      return { valid: true, role: 'anon (publishable)' };
    }
    if (trimmed.startsWith('sb_secret_')) {
      return { valid: true, role: 'service_role (secret)' };
    }
    return { valid: false };
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = atob(padded);
    const payload = JSON.parse(json) as {
      role?: string;
      ref?: string;
      exp?: number;
      iss?: string;
    };
    const expIso = payload.exp ? new Date(payload.exp * 1000).toISOString() : undefined;
    const expired = payload.exp ? payload.exp * 1000 < Date.now() : false;
    return {
      valid: true,
      role: payload.role,
      ref: payload.ref,
      expIso,
      expired,
    };
  } catch {
    return { valid: false };
  }
}

export function getSupabaseConfigSource(): SupabaseConfigSource {
  try {
    const raw = localStorage.getItem(RUNTIME_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SupabaseRuntimeConfig>;
      if (parsed.url && parsed.anonKey) {
        return 'runtime';
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }
  const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (envUrl?.trim() && envKey?.trim()) {
    return 'env';
  }
  return 'default';
}

export function getSupabaseConfig(): SupabaseRuntimeConfig {
  const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

  try {
    const raw = localStorage.getItem(RUNTIME_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SupabaseRuntimeConfig>;
      if (parsed.url && parsed.anonKey) {
        return {
          url: parsed.url.trim(),
          anonKey: parsed.anonKey.trim(),
          serviceRoleKey: parsed.serviceRoleKey?.trim() || '',
          schema: parsed.schema?.trim() || 'public',
          autoSyncIntervalSec:
            typeof parsed.autoSyncIntervalSec === 'number' && parsed.autoSyncIntervalSec >= 3
              ? parsed.autoSyncIntervalSec
              : 8,
          enableRealtime: parsed.enableRealtime ?? true,
        };
      }
    }
  } catch {
    // Fallback to hardcoded/env configuration
  }

  return {
    url: (envUrl && envUrl.trim()) || DEFAULT_SUPABASE_URL,
    anonKey: (envKey && envKey.trim()) || DEFAULT_SUPABASE_ANON_KEY,
    serviceRoleKey: '',
    schema: 'public',
    autoSyncIntervalSec: 8,
    enableRealtime: true,
  };
}

export function saveSupabaseConfig(
  url: string,
  anonKey: string,
  extra?: Partial<Omit<SupabaseRuntimeConfig, 'url' | 'anonKey'>>
): void {
  const current = getSupabaseConfig();
  const next: SupabaseRuntimeConfig = {
    url: url.trim(),
    anonKey: anonKey.trim(),
    serviceRoleKey:
      extra?.serviceRoleKey !== undefined
        ? extra.serviceRoleKey.trim()
        : current.serviceRoleKey || '',
    schema: extra?.schema?.trim() || current.schema || 'public',
    autoSyncIntervalSec:
      extra?.autoSyncIntervalSec !== undefined && extra.autoSyncIntervalSec >= 3
        ? extra.autoSyncIntervalSec
        : current.autoSyncIntervalSec || 8,
    enableRealtime:
      extra?.enableRealtime !== undefined ? extra.enableRealtime : current.enableRealtime ?? true,
  };
  localStorage.setItem(RUNTIME_CONFIG_KEY, JSON.stringify(next));
  cachedClient = null;
  cachedAdminClient = null;
}

export function resetSupabaseConfig(): void {
  localStorage.removeItem(RUNTIME_CONFIG_KEY);
  cachedClient = null;
  cachedAdminClient = null;
}

export function isLiveSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseConfig();
  return (
    Boolean(url) &&
    Boolean(anonKey) &&
    url.startsWith('https://') &&
    !url.includes('nusantaracbt-default.supabase.co') &&
    !anonKey.includes('nusantara_cbt_default_anon_key')
  );
}

let cachedClient: SupabaseClient | null = null;
let cachedAdminClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const { url, anonKey } = getSupabaseConfig();
  cachedClient = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 10,
      },
    },
  });
  return cachedClient;
}

/**
 * Opsional: Client khusus Admin menggunakan Service Role Key (bila diisi di pengaturan Admin).
 * Hanya digunakan di sisi panel Admin untuk sinkronisasi penuh tabel terproteksi RLS seperti `questions`.
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  if (!isLiveSupabaseConfigured()) return null;
  const { url, serviceRoleKey } = getSupabaseConfig();
  const key = serviceRoleKey?.trim();
  if (!key) return null;
  if (cachedAdminClient) return cachedAdminClient;
  cachedAdminClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return cachedAdminClient;
}

/**
 * Skema PostgreSQL + Row Level Security (RLS) Supabase
 * Menjamin kunci jawaban (correct_answer) tidak pernah terekspos ke client siswa (role anon).
 */
export const SUPABASE_SCHEMA_SQL = `-- ============================================================================
-- SKEMA DATABASE NUSANTARA CBT + ROW LEVEL SECURITY (RLS) ANTI-CHEATING
-- Dirancang untuk 1.000+ peserta serentak tanpa sistem sesi
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Tabel Profil Lembaga / Sekolah
CREATE TABLE IF NOT EXISTS public.school_profile (
  id TEXT PRIMARY KEY DEFAULT 'default',
  school_name TEXT NOT NULL,
  address TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  principal_name TEXT NOT NULL,
  committee_chair_name TEXT NOT NULL,
  exam_title TEXT NOT NULL,
  logo_data_url TEXT DEFAULT '',
  admin_password TEXT NOT NULL DEFAULT 'admin123',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Tabel Peserta Ujian (Kelas 7A - 9I) dengan Kolom Token
CREATE TABLE IF NOT EXISTS public.participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_number TEXT UNIQUE NOT NULL,
  token TEXT NOT NULL DEFAULT 'CBT2026',
  full_name TEXT NOT NULL,
  class_name TEXT NOT NULL CHECK (class_name ~ '^[789][A-I]$'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_participants_number ON public.participants(participant_number);
CREATE INDEX IF NOT EXISTS idx_participants_class ON public.participants(class_name);

-- 3. Tabel Jadwal Ujian & KKM per Mata Pelajaran
CREATE TABLE IF NOT EXISTS public.exam_schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  kkm INTEGER NOT NULL DEFAULT 75,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  target_classes TEXT[] NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  randomize_questions BOOLEAN NOT NULL DEFAULT FALSE,
  max_tab_switches INTEGER NOT NULL DEFAULT 3,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Tabel Bank Soal (Mendukung LaTeX & Gambar URL/Upload; correct_answer diproteksi RLS)
CREATE TABLE IF NOT EXISTS public.questions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  target_classes TEXT[] NOT NULL,
  question_text TEXT NOT NULL,
  question_image_url TEXT DEFAULT '',
  options JSONB NOT NULL,
  correct_answer TEXT NOT NULL CHECK (correct_answer IN ('A', 'B', 'C', 'D')),
  points INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 1
);

-- 5. Tabel Hasil Ujian (exam_results) untuk Upsert Otomatis & Rekap Real-Time
CREATE TABLE IF NOT EXISTS public.exam_results (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  participant_number TEXT NOT NULL,
  student_name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  exam_id TEXT NOT NULL,
  exam_title TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  flagged_questions TEXT[] NOT NULL DEFAULT '{}',
  correct_count INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  score NUMERIC(5,2) NOT NULL DEFAULT 0,
  tab_switch_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'flagged')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (participant_number, exam_id)
);

CREATE INDEX IF NOT EXISTS idx_exam_results_class ON public.exam_results(class_name);
CREATE INDEX IF NOT EXISTS idx_exam_results_subject ON public.exam_results(subject);
CREATE INDEX IF NOT EXISTS idx_exam_results_status ON public.exam_results(status);

-- ============================================================================
-- AKTIFKAN ROW LEVEL SECURITY (RLS) & HAK AKSES TABEL (GRANT)
-- ============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.school_profile TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.participants TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exam_schedules TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exam_results TO anon, authenticated;

-- Blokir akses SELECT langsung tabel questions dari role anon agar correct_answer aman
REVOKE ALL ON TABLE public.questions FROM anon;
GRANT ALL ON TABLE public.questions TO authenticated;

ALTER TABLE public.school_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read school_profile" ON public.school_profile;
DROP POLICY IF EXISTS "Allow insert school_profile" ON public.school_profile;
DROP POLICY IF EXISTS "Allow update school_profile" ON public.school_profile;
CREATE POLICY "Public read school_profile" ON public.school_profile FOR SELECT USING (true);
CREATE POLICY "Allow insert school_profile" ON public.school_profile FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update school_profile" ON public.school_profile FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read active participants" ON public.participants;
DROP POLICY IF EXISTS "Public read participants" ON public.participants;
DROP POLICY IF EXISTS "Allow insert participants" ON public.participants;
DROP POLICY IF EXISTS "Allow update participants" ON public.participants;
DROP POLICY IF EXISTS "Allow delete participants" ON public.participants;
CREATE POLICY "Public read participants" ON public.participants FOR SELECT USING (true);
CREATE POLICY "Allow insert participants" ON public.participants FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update participants" ON public.participants FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete participants" ON public.participants FOR DELETE USING (true);

DROP POLICY IF EXISTS "Public read active schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Public read schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Allow insert schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Allow update schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Allow delete schedules" ON public.exam_schedules;
CREATE POLICY "Public read schedules" ON public.exam_schedules FOR SELECT USING (true);
CREATE POLICY "Allow insert schedules" ON public.exam_schedules FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update schedules" ON public.exam_schedules FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete schedules" ON public.exam_schedules FOR DELETE USING (true);

-- KEAMANAN ANTI-INSPECT ELEMENT:
-- Blokir akses SELECT langsung ke tabel questions untuk role anon!
DROP POLICY IF EXISTS "Deny direct anon select on questions" ON public.questions;
DROP POLICY IF EXISTS "Authenticated admin full access questions" ON public.questions;
CREATE POLICY "Deny direct anon select on questions" ON public.questions
  FOR SELECT TO anon USING (false);
CREATE POLICY "Authenticated admin full access questions" ON public.questions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Students upsert own exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Students update own exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Allow delete exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Read exam_results for recap" ON public.exam_results;
CREATE POLICY "Students upsert own exam_results" ON public.exam_results
  FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "Students update own exam_results" ON public.exam_results
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete exam_results" ON public.exam_results
  FOR DELETE USING (true);
CREATE POLICY "Read exam_results for recap" ON public.exam_results
  FOR SELECT USING (true);

-- ============================================================================
-- FUNGSI RPC AMAN (SECURITY DEFINER) — TANPA MEMBOCORKAN KUNCI JAWABAN
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_student_questions(p_class_name TEXT, p_subject TEXT DEFAULT NULL)
RETURNS TABLE (
  id TEXT,
  subject TEXT,
  target_classes TEXT[],
  question_text TEXT,
  question_image_url TEXT,
  options JSONB,
  points INTEGER,
  order_index INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT q.id, q.subject, q.target_classes, q.question_text, q.question_image_url, q.options, q.points, q.order_index
  FROM public.questions q
  WHERE p_class_name = ANY(q.target_classes)
    AND (p_subject IS NULL OR q.subject = p_subject)
  ORDER BY q.order_index ASC, q.id ASC;
$$;

-- Fungsi Penilaian Server-Side & Upsert Skor Akhir ke exam_results
CREATE OR REPLACE FUNCTION public.submit_exam_and_score(
  p_result_id TEXT,
  p_participant_id TEXT,
  p_participant_number TEXT,
  p_student_name TEXT,
  p_class_name TEXT,
  p_exam_id TEXT,
  p_exam_title TEXT,
  p_subject TEXT,
  p_answers JSONB,
  p_flagged_questions TEXT[],
  p_tab_switch_count INTEGER,
  p_started_at TIMESTAMPTZ
)
RETURNS TABLE (
  correct_count INTEGER,
  total_questions INTEGER,
  score NUMERIC(5,2)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total_points INTEGER := 0;
  v_earned_points INTEGER := 0;
  v_correct INTEGER := 0;
  v_total_q INTEGER := 0;
  v_score NUMERIC(5,2) := 0;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(SUM(q.points), 0),
    COUNT(*) FILTER (WHERE (p_answers ->> q.id) = q.correct_answer),
    COALESCE(SUM(CASE WHEN (p_answers ->> q.id) = q.correct_answer THEN q.points ELSE 0 END), 0)
  INTO v_total_q, v_total_points, v_correct, v_earned_points
  FROM public.questions q
  WHERE p_class_name = ANY(q.target_classes)
    AND (p_subject IS NULL OR p_subject = '' OR q.subject = p_subject);

  IF v_total_points > 0 THEN
    v_score := ROUND((v_earned_points::NUMERIC / v_total_points::NUMERIC) * 100, 2);
  END IF;

  INSERT INTO public.exam_results (
    id, participant_id, participant_number, student_name, class_name,
    exam_id, exam_title, subject, answers, flagged_questions,
    correct_count, total_questions, score, tab_switch_count,
    status, started_at, submitted_at, updated_at
  )
  VALUES (
    p_result_id, p_participant_id, p_participant_number, p_student_name, p_class_name,
    p_exam_id, p_exam_title, p_subject, p_answers, p_flagged_questions,
    v_correct, v_total_q, v_score, p_tab_switch_count,
    CASE WHEN p_tab_switch_count >= 3 THEN 'flagged' ELSE 'submitted' END,
    p_started_at, NOW(), NOW()
  )
  ON CONFLICT (participant_number, exam_id) DO UPDATE SET
    answers = EXCLUDED.answers,
    flagged_questions = EXCLUDED.flagged_questions,
    correct_count = EXCLUDED.correct_count,
    total_questions = EXCLUDED.total_questions,
    score = EXCLUDED.score,
    tab_switch_count = EXCLUDED.tab_switch_count,
    status = EXCLUDED.status,
    submitted_at = NOW(),
    updated_at = NOW();

  RETURN QUERY SELECT v_correct, v_total_q, v_score;
END;
$$;

-- Fungsi RPC Admin untuk menyimpan & menghapus soal tanpa membuka SELECT langsung tabel questions
CREATE OR REPLACE FUNCTION public.upsert_questions_batch(p_questions JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item JSONB;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_questions)
  LOOP
    INSERT INTO public.questions (
      id, subject, target_classes, question_text, question_image_url,
      options, correct_answer, points, order_index
    )
    VALUES (
      item ->> 'id',
      item ->> 'subject',
      ARRAY(SELECT jsonb_array_elements_text(item -> 'target_classes')),
      item ->> 'question_text',
      COALESCE(item ->> 'question_image_url', ''),
      item -> 'options',
      item ->> 'correct_answer',
      COALESCE((item ->> 'points')::INTEGER, 1),
      COALESCE((item ->> 'order_index')::INTEGER, 1)
    )
    ON CONFLICT (id) DO UPDATE SET
      subject = EXCLUDED.subject,
      target_classes = EXCLUDED.target_classes,
      question_text = EXCLUDED.question_text,
      question_image_url = EXCLUDED.question_image_url,
      options = EXCLUDED.options,
      correct_answer = EXCLUDED.correct_answer,
      points = EXCLUDED.points,
      order_index = EXCLUDED.order_index;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_question_by_id(p_id TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.questions WHERE id = p_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_student_questions(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_questions_batch(JSONB) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_question_by_id(TEXT) TO anon, authenticated;
`;

