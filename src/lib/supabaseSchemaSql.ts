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
  kemenag_logo_data_url TEXT DEFAULT '',
  admin_password TEXT NOT NULL DEFAULT 'admin123',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.school_profile
  ADD COLUMN IF NOT EXISTS kemenag_logo_data_url TEXT DEFAULT '';

-- 2. Tabel Peserta Ujian (Kelas 7A - 9I) dengan Kolom Token (id TEXT agar kompatibel seed & UUID)
CREATE TABLE IF NOT EXISTS public.participants (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  participant_number TEXT UNIQUE NOT NULL,
  token TEXT NOT NULL DEFAULT 'CBT2026',
  full_name TEXT NOT NULL,
  class_name TEXT NOT NULL CHECK (class_name ~ '^[789][A-I]$'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'participants' AND column_name = 'id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE public.participants ALTER COLUMN id TYPE TEXT USING id::text;
    ALTER TABLE public.participants ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_participants_number ON public.participants(participant_number);
CREATE INDEX IF NOT EXISTS idx_participants_number_lower ON public.participants(LOWER(TRIM(participant_number)));
CREATE INDEX IF NOT EXISTS idx_participants_number_upper ON public.participants(UPPER(TRIM(participant_number)));
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

-- 4. Tabel Bank Soal (Pilihan Ganda, Benar/Salah, Menjodohkan; correct_answer diproteksi RLS)
CREATE TABLE IF NOT EXISTS public.questions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  target_classes TEXT[] NOT NULL,
  question_type TEXT NOT NULL DEFAULT 'multiple_choice',
  question_text TEXT NOT NULL,
  question_image_url TEXT DEFAULT '',
  options JSONB NOT NULL,
  matching_pairs JSONB DEFAULT NULL,
  correct_answer TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS question_type TEXT NOT NULL DEFAULT 'multiple_choice';
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS matching_pairs JSONB DEFAULT NULL;
ALTER TABLE public.questions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_correct_answer_check;

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
  question_ids TEXT[] DEFAULT NULL,
  correct_count INTEGER NOT NULL DEFAULT 0,
  total_questions INTEGER NOT NULL DEFAULT 0,
  score NUMERIC(5,2) NOT NULL DEFAULT 0,
  tab_switch_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted', 'flagged')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  finalized_by TEXT DEFAULT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (participant_number, exam_id)
);

ALTER TABLE public.exam_results ADD COLUMN IF NOT EXISTS question_ids TEXT[] DEFAULT NULL;
ALTER TABLE public.exam_results ADD COLUMN IF NOT EXISTS finalized_by TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_questions_subject_lower ON public.questions(LOWER(TRIM(subject)));
CREATE INDEX IF NOT EXISTS idx_questions_target_classes_gin ON public.questions USING GIN (target_classes);
CREATE INDEX IF NOT EXISTS idx_questions_updated_at ON public.questions(updated_at DESC);

-- Hapus indeks tunggal yang redundan untuk mengurangi overhead penulisan & ukuran database
DROP INDEX IF EXISTS public.idx_exam_results_class;
DROP INDEX IF EXISTS public.idx_exam_results_subject;
DROP INDEX IF EXISTS public.idx_exam_results_status;

CREATE INDEX IF NOT EXISTS idx_exam_results_exam_status ON public.exam_results(exam_id, status);
CREATE INDEX IF NOT EXISTS idx_exam_results_participant_lower_exam ON public.exam_results(LOWER(TRIM(participant_number)), exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_results_updated_at ON public.exam_results(updated_at DESC);

-- 6. Tabel Akun Staf & RBAC (Proktor, Guru Mapel, Administrator)
CREATE TABLE IF NOT EXISTS public.staff_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'guru_mapel' CHECK (role_type IN ('admin', 'proktor', 'guru_mapel', 'custom')),
  role_label TEXT NOT NULL DEFAULT 'Guru Mapel',
  allowed_tabs TEXT[] NOT NULL DEFAULT '{}',
  assigned_subjects TEXT[] NOT NULL DEFAULT '{}',
  restrict_to_assigned_subjects BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trigger normalisasi participant_number konsisten (TRIM + UPPER) di tabel participants & exam_results
CREATE OR REPLACE FUNCTION public.normalize_participant_number_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.participant_number := UPPER(TRIM(COALESCE(NEW.participant_number, '')));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_participant_number_participants ON public.participants;
CREATE TRIGGER trg_normalize_participant_number_participants
  BEFORE INSERT OR UPDATE ON public.participants
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_participant_number_trigger();

DROP TRIGGER IF EXISTS trg_normalize_participant_number_results ON public.exam_results;
CREATE TRIGGER trg_normalize_participant_number_results
  BEFORE INSERT OR UPDATE ON public.exam_results
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_participant_number_trigger();

-- Backfill idempoten bila ada data lama berhuruf kecil/spasi
DO $$
BEGIN
  UPDATE public.participants
  SET participant_number = UPPER(TRIM(participant_number))
  WHERE participant_number <> UPPER(TRIM(participant_number));
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

DO $$
BEGIN
  UPDATE public.exam_results
  SET participant_number = UPPER(TRIM(participant_number))
  WHERE participant_number <> UPPER(TRIM(participant_number));
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- ============================================================================
-- AKTIFKAN ROW LEVEL SECURITY (RLS) & HAK AKSES TABEL (GRANT KETAT)
-- ============================================================================
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- school_profile: anon hanya boleh SELECT kolom publik (admin_password diblokir di level kolom & RLS)
REVOKE ALL ON TABLE public.school_profile FROM PUBLIC, anon;
GRANT SELECT (id, school_name, address, academic_year, principal_name, committee_chair_name, exam_title, logo_data_url, kemenag_logo_data_url, updated_at) ON TABLE public.school_profile TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.school_profile TO authenticated, service_role;

-- participants: blokir akses langsung role anon (login & preflight lewat RPC aman, manajemen lewat RPC staf terverifikasi)
REVOKE ALL ON TABLE public.participants FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.participants TO authenticated, service_role;

-- exam_schedules: anon hanya boleh SELECT jadwal ujian; seluruh mutasi wajib lewat RPC staf terverifikasi atau role privileged
REVOKE ALL ON TABLE public.exam_schedules FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.exam_schedules TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exam_schedules TO authenticated, service_role;

-- exam_results: anon hanya boleh SELECT; INSERT/UPDATE/DELETE wajib lewat RPC SECURITY DEFINER atau role privileged
REVOKE ALL ON TABLE public.exam_results FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.exam_results TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exam_results TO authenticated, service_role;

-- staff_accounts: blokir total akses langsung role anon (login & manajemen staf lewat RPC SECURITY DEFINER)
REVOKE ALL ON TABLE public.staff_accounts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_accounts TO authenticated, service_role;

-- questions: blokir total akses langsung role anon agar correct_answer aman
REVOKE ALL ON TABLE public.questions FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.questions TO authenticated, service_role;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

ALTER TABLE public.school_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read school_profile" ON public.school_profile;
DROP POLICY IF EXISTS "Allow insert school_profile" ON public.school_profile;
DROP POLICY IF EXISTS "Allow update school_profile" ON public.school_profile;
DROP POLICY IF EXISTS "Privileged insert school_profile" ON public.school_profile;
DROP POLICY IF EXISTS "Privileged update school_profile" ON public.school_profile;
DROP POLICY IF EXISTS "Privileged delete school_profile" ON public.school_profile;
CREATE POLICY "Public read school_profile" ON public.school_profile
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "Privileged insert school_profile" ON public.school_profile
  FOR INSERT TO authenticated, service_role WITH CHECK (true);
CREATE POLICY "Privileged update school_profile" ON public.school_profile
  FOR UPDATE TO authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "Privileged delete school_profile" ON public.school_profile
  FOR DELETE TO authenticated, service_role USING (true);

DROP POLICY IF EXISTS "Public read active participants" ON public.participants;
DROP POLICY IF EXISTS "Public read participants" ON public.participants;
DROP POLICY IF EXISTS "Allow insert participants" ON public.participants;
DROP POLICY IF EXISTS "Allow update participants" ON public.participants;
DROP POLICY IF EXISTS "Allow delete participants" ON public.participants;
DROP POLICY IF EXISTS "Privileged write participants" ON public.participants;
DROP POLICY IF EXISTS "Deny anon direct access participants" ON public.participants;
DROP POLICY IF EXISTS "Privileged full access participants" ON public.participants;
CREATE POLICY "Deny anon direct access participants" ON public.participants
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "Privileged full access participants" ON public.participants
  FOR ALL TO authenticated, service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public read active schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Public read schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Allow insert schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Allow update schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Allow delete schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Privileged write schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Privileged insert schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Privileged update schedules" ON public.exam_schedules;
DROP POLICY IF EXISTS "Privileged delete schedules" ON public.exam_schedules;
CREATE POLICY "Public read schedules" ON public.exam_schedules
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "Privileged insert schedules" ON public.exam_schedules
  FOR INSERT TO authenticated, service_role WITH CHECK (true);
CREATE POLICY "Privileged update schedules" ON public.exam_schedules
  FOR UPDATE TO authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "Privileged delete schedules" ON public.exam_schedules
  FOR DELETE TO authenticated, service_role USING (true);

-- KEAMANAN ANTI-INSPECT ELEMENT:
-- Blokir akses SELECT langsung ke tabel questions untuk role anon!
DROP POLICY IF EXISTS "Deny direct anon select on questions" ON public.questions;
DROP POLICY IF EXISTS "Authenticated admin full access questions" ON public.questions;
CREATE POLICY "Deny direct anon select on questions" ON public.questions
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "Authenticated admin full access questions" ON public.questions
  FOR ALL TO authenticated, service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Students upsert own exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Students update own exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Allow delete exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Read exam_results for recap" ON public.exam_results;
DROP POLICY IF EXISTS "Privileged insert exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Privileged update exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Privileged delete exam_results" ON public.exam_results;
CREATE POLICY "Read exam_results for recap" ON public.exam_results
  FOR SELECT TO anon, authenticated, service_role USING (true);
CREATE POLICY "Privileged insert exam_results" ON public.exam_results
  FOR INSERT TO authenticated, service_role WITH CHECK (true);
CREATE POLICY "Privileged update exam_results" ON public.exam_results
  FOR UPDATE TO authenticated, service_role USING (true) WITH CHECK (true);
CREATE POLICY "Privileged delete exam_results" ON public.exam_results
  FOR DELETE TO authenticated, service_role USING (true);

DROP POLICY IF EXISTS "Public read staff_accounts" ON public.staff_accounts;
DROP POLICY IF EXISTS "Allow insert staff_accounts" ON public.staff_accounts;
DROP POLICY IF EXISTS "Allow update staff_accounts" ON public.staff_accounts;
DROP POLICY IF EXISTS "Allow delete staff_accounts" ON public.staff_accounts;
DROP POLICY IF EXISTS "Deny anon direct access staff_accounts" ON public.staff_accounts;
DROP POLICY IF EXISTS "Service authenticated access staff_accounts" ON public.staff_accounts;
CREATE POLICY "Deny anon direct access staff_accounts" ON public.staff_accounts
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "Service authenticated access staff_accounts" ON public.staff_accounts
  FOR ALL TO authenticated, service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- FUNGSI RPC AMAN (SECURITY DEFINER) — WAKTU SERVER, GUARD, & PENILAIAN
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NOW();
$$;

DROP FUNCTION IF EXISTS public.get_student_questions(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_student_questions(p_class_name TEXT, p_subject TEXT DEFAULT NULL)
RETURNS TABLE (
  id TEXT,
  subject TEXT,
  target_classes TEXT[],
  question_type TEXT,
  question_text TEXT,
  question_image_url TEXT,
  options JSONB,
  points INTEGER,
  order_index INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
  SELECT q.id, q.subject, q.target_classes, COALESCE(q.question_type, 'multiple_choice'), q.question_text, q.question_image_url, q.options, q.points, q.order_index
  FROM public.questions q
  WHERE q.target_classes @> ARRAY[p_class_name]
    AND (p_subject IS NULL OR TRIM(p_subject) = '' OR LOWER(TRIM(q.subject)) = LOWER(TRIM(p_subject)))
  ORDER BY q.order_index ASC, q.id ASC;
$$;

-- Helper internal verifikasi staf / service_role pada RPC admin SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.assert_verified_staff(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL,
  p_required_tab TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role', ''),
    ''
  );
  v_norm_id TEXT := LOWER(TRIM(COALESCE(p_staff_user_id, '')));
  v_sha TEXT := LOWER(TRIM(COALESCE(p_staff_password_sha256, '')));
  v_staff public.staff_accounts%ROWTYPE;
  v_stored TEXT;
  v_admin_pwd TEXT;
  v_default_sha TEXT;
  v_matched BOOLEAN := FALSE;
BEGIN
  -- Hanya lewati verifikasi jika caller benar-benar service_role/authenticated atau eksekusi langsung SQL Editor (tanpa JWT anon)
  IF v_jwt_role IN ('service_role', 'authenticated', 'supabase_admin')
     OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'authenticated', 'supabase_admin')) THEN
    RETURN;
  END IF;

  IF v_norm_id = '' OR v_sha = '' THEN
    RAISE EXCEPTION 'Unauthorized staff operation' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_staff
  FROM public.staff_accounts s
  WHERE LOWER(TRIM(s.user_id)) = v_norm_id
    AND s.is_active = TRUE
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_stored := TRIM(COALESCE(v_staff.password_hash, ''));
    IF v_stored <> '' THEN
      IF LOWER(v_stored) = v_sha THEN
        v_matched := TRUE;
      ELSIF LEFT(v_sha, 7) = 'sha256$'
            AND LENGTH(v_stored) = 64
            AND LOWER(v_stored) = SUBSTRING(v_sha FROM 8) THEN
        v_matched := TRUE;
      ELSIF LEFT(LOWER(v_stored), 7) <> 'sha256$' THEN
        IF ('sha256$' || encode(pg_catalog.sha256(convert_to(v_stored, 'UTF8')), 'hex')) = v_sha THEN
          v_matched := TRUE;
        END IF;
      END IF;

      IF v_matched THEN
        IF v_staff.role_type = 'admin'
           OR p_required_tab IS NULL
           OR TRIM(p_required_tab) = ''
           OR p_required_tab = ANY(v_staff.allowed_tabs) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'Forbidden staff tab privilege' USING ERRCODE = '42501';
      END IF;
      -- Jika akun sudah terdaftar dengan password_hash di staff_accounts namun sandi salah, langsung tolak (jangan fallback ke school_profile)
      RAISE EXCEPTION 'Unauthorized staff credentials' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_norm_id = 'admin' THEN
    SELECT sp.admin_password INTO v_admin_pwd
    FROM public.school_profile sp
    WHERE sp.id = 'default'
    LIMIT 1;

    v_stored := TRIM(COALESCE(v_admin_pwd, ''));
    IF v_stored <> '' THEN
      IF LOWER(v_stored) = v_sha THEN
        RETURN;
      ELSIF LEFT(v_sha, 7) = 'sha256$'
            AND LENGTH(v_stored) = 64
            AND LOWER(v_stored) = SUBSTRING(v_sha FROM 8) THEN
        RETURN;
      ELSIF LEFT(LOWER(v_stored), 7) <> 'sha256$' THEN
        IF ('sha256$' || encode(pg_catalog.sha256(convert_to(v_stored, 'UTF8')), 'hex')) = v_sha THEN
          RETURN;
        END IF;
      END IF;
    END IF;

    -- Bootstrap pertama kali saat tabel cloud masih kosong total
    IF NOT EXISTS (SELECT 1 FROM public.staff_accounts)
       AND NOT EXISTS (SELECT 1 FROM public.school_profile) THEN
      v_default_sha := 'sha256$' || encode(pg_catalog.sha256(convert_to('admin123', 'UTF8')), 'hex');
      IF v_sha = v_default_sha THEN
        RETURN;
      END IF;
    END IF;
  END IF;

  RAISE EXCEPTION 'Unauthorized staff credentials' USING ERRCODE = '42501';
END;
$$;

-- Guard Atomik Progres Ujian: 1 statement upsert tanpa menahan FOR UPDATE lock terlebih dahulu
CREATE OR REPLACE FUNCTION public.upsert_exam_progress(
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
  p_total_questions INTEGER,
  p_tab_switch_count INTEGER,
  p_started_at TIMESTAMPTZ,
  p_question_ids TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  applied BOOLEAN,
  current_status TEXT,
  submitted_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  v_existing_status TEXT;
  v_existing_submitted TIMESTAMPTZ;
  v_norm_participant TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_effective_question_ids TEXT[] := CASE
    WHEN p_question_ids IS NOT NULL AND array_length(p_question_ids, 1) IS NOT NULL THEN p_question_ids
    ELSE NULL
  END;
BEGIN
  IF v_norm_participant = '' OR COALESCE(TRIM(p_exam_id), '') = '' THEN
    RETURN QUERY SELECT FALSE, 'invalid'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO public.exam_results (
    id, participant_id, participant_number, student_name, class_name,
    exam_id, exam_title, subject, answers, flagged_questions, question_ids,
    correct_count, total_questions, score, tab_switch_count,
    status, started_at, submitted_at, updated_at
  )
  VALUES (
    p_result_id, p_participant_id, v_norm_participant, p_student_name, p_class_name,
    p_exam_id, p_exam_title, COALESCE(p_subject, ''), COALESCE(p_answers, '{}'::jsonb),
    COALESCE(p_flagged_questions, '{}'::text[]), v_effective_question_ids,
    0, GREATEST(COALESCE(p_total_questions, 0), 0), 0, GREATEST(COALESCE(p_tab_switch_count, 0), 0),
    'in_progress', COALESCE(p_started_at, NOW()), NULL, NOW()
  )
  ON CONFLICT (participant_number, exam_id) DO UPDATE SET
    answers = EXCLUDED.answers,
    flagged_questions = EXCLUDED.flagged_questions,
    question_ids = COALESCE(public.exam_results.question_ids, EXCLUDED.question_ids),
    total_questions = GREATEST(EXCLUDED.total_questions, 0),
    tab_switch_count = GREATEST(public.exam_results.tab_switch_count, EXCLUDED.tab_switch_count),
    updated_at = NOW()
  WHERE public.exam_results.status = 'in_progress'
    AND public.exam_results.submitted_at IS NULL;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, 'in_progress'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT er.status, er.submitted_at
  INTO v_existing_status, v_existing_submitted
  FROM public.exam_results er
  WHERE er.participant_number = v_norm_participant
    AND er.exam_id = p_exam_id
  LIMIT 1;

  RETURN QUERY SELECT FALSE, COALESCE(v_existing_status, 'submitted')::TEXT, v_existing_submitted;
END;
$$;

-- Fungsi Penilaian Server-Side & Upsert Skor Akhir ke exam_results
-- Dioptimasi untuk 800-1.000+ siswa serentak:
-- 1. Penilaian soal dijalankan TANPA menahan row lock (FOR UPDATE) sehingga tidak bentrok dengan autosave.
-- 2. Query soal menggunakan Primary Key index (q.id = ANY) atau GIN index (@>) agar super cepat.
-- 3. statement_timeout dinaikkan ke 15 detik khusus di dalam RPC agar tidak terpotong batas 3 detik role anon.
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
  p_started_at TIMESTAMPTZ,
  p_max_tab_switches INTEGER DEFAULT 3,
  p_question_ids TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  correct_count INTEGER,
  total_questions INTEGER,
  score NUMERIC(5,2)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_total_points NUMERIC := 0;
  v_earned_points NUMERIC := 0;
  v_correct INTEGER := 0;
  v_total_q INTEGER := 0;
  v_score NUMERIC(5,2) := 0;
  v_existing RECORD;
  v_sched_subject TEXT;
  v_sched_max_tabs INTEGER;
  v_effective_subject TEXT;
  v_effective_max_tabs INTEGER;
  v_effective_tab_switches INTEGER;
  v_effective_question_ids TEXT[];
  v_target_status TEXT;
  v_norm_participant TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_q RECORD;
  v_ans_text TEXT;
  v_correct_map JSONB;
  v_student_map JSONB;
  v_pair_total INTEGER;
  v_pair_matched INTEGER;
  v_kv RECORD;
  v_has_q_ids BOOLEAN := FALSE;
  v_reconcile_auto_expired BOOLEAN := FALSE;
  v_effective_answers JSONB := COALESCE(p_answers, '{}'::jsonb);
  v_existing_ans_count INTEGER := 0;
  v_merged_ans_count INTEGER := 0;
BEGIN
  -- Pembacaan awal non-locking menggunakan UNIQUE index (participant_number, exam_id)
  SELECT er.id, er.question_ids, er.answers, er.correct_count, er.total_questions, er.score, er.status, er.submitted_at, er.tab_switch_count, er.finalized_by
  INTO v_existing
  FROM public.exam_results er
  WHERE er.participant_number = v_norm_participant
    AND er.exam_id = p_exam_id
  LIMIT 1;

  IF FOUND AND (v_existing.status <> 'in_progress' OR v_existing.submitted_at IS NOT NULL) THEN
    -- Izinkan rekonsiliasi aman SATU KALI jika hasil sebelumnya ditutup otomatis oleh server (auto_expired)
    -- sementara perangkat siswa sempat offline/terantre dan mengirim jawaban lokal lebih lengkap dalam 30 menit.
    IF v_existing.finalized_by = 'auto_expired'
       AND (v_existing.submitted_at IS NULL OR NOW() - v_existing.submitted_at <= INTERVAL '30 minutes') THEN
      v_effective_answers := COALESCE(v_existing.answers, '{}'::jsonb) || COALESCE(p_answers, '{}'::jsonb);
      SELECT COUNT(*) INTO v_existing_ans_count
      FROM jsonb_each_text(COALESCE(v_existing.answers, '{}'::jsonb))
      WHERE NULLIF(TRIM(COALESCE(value, '')), '') IS NOT NULL
        AND TRIM(COALESCE(value, '')) <> '{}';
      SELECT COUNT(*) INTO v_merged_ans_count
      FROM jsonb_each_text(v_effective_answers)
      WHERE NULLIF(TRIM(COALESCE(value, '')), '') IS NOT NULL
        AND TRIM(COALESCE(value, '')) <> '{}';
      IF v_merged_ans_count > v_existing_ans_count THEN
        v_reconcile_auto_expired := TRUE;
      END IF;
    END IF;

    IF NOT v_reconcile_auto_expired THEN
      RETURN QUERY SELECT v_existing.correct_count, v_existing.total_questions, v_existing.score;
      RETURN;
    END IF;
  END IF;

  -- Prioritaskan exam_id dalam menentukan mata pelajaran & batas pelanggaran jadwal
  SELECT s.subject, s.max_tab_switches
  INTO v_sched_subject, v_sched_max_tabs
  FROM public.exam_schedules s
  WHERE s.id = p_exam_id
  LIMIT 1;

  IF NOT FOUND AND p_subject IS NOT NULL AND TRIM(p_subject) <> '' THEN
    SELECT s.subject, s.max_tab_switches
    INTO v_sched_subject, v_sched_max_tabs
    FROM public.exam_schedules s
    WHERE LOWER(TRIM(s.subject)) = LOWER(TRIM(p_subject))
    LIMIT 1;
  END IF;

  v_effective_subject := COALESCE(NULLIF(TRIM(v_sched_subject), ''), NULLIF(TRIM(p_subject), ''), '');
  -- Prioritaskan batas pelanggaran dari jadwal di server (cegah manipulasi parameter klien)
  v_effective_max_tabs := COALESCE(v_sched_max_tabs, p_max_tab_switches, 3);
  -- Prioritaskan daftar soal yang sudah tercatat saat sesi dimulai di server
  v_effective_question_ids := COALESCE(NULLIF(v_existing.question_ids, '{}'), NULLIF(p_question_ids, '{}'));
  v_has_q_ids := v_effective_question_ids IS NOT NULL AND array_length(v_effective_question_ids, 1) IS NOT NULL;
  v_effective_tab_switches := GREATEST(COALESCE(v_existing.tab_switch_count, 0), GREATEST(COALESCE(p_tab_switch_count, 0), 0));

  -- Cabang query ramah-index: Primary Key (questions_pkey) jika question_ids tersedia, atau GIN index (@>) jika tidak
  IF v_has_q_ids THEN
    FOR v_q IN
      SELECT q.id, COALESCE(q.question_type, 'multiple_choice') AS q_type, q.correct_answer, COALESCE(q.points, 1) AS pts
      FROM public.questions q
      WHERE q.id = ANY(v_effective_question_ids)
        AND q.target_classes @> ARRAY[p_class_name]
        AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject))
    LOOP
      v_total_q := v_total_q + 1;
      v_total_points := v_total_points + v_q.pts;
      v_ans_text := v_effective_answers ->> v_q.id;

      IF v_q.q_type = 'matching' OR LEFT(TRIM(v_q.correct_answer), 1) = '{' THEN
        BEGIN
          v_correct_map := v_q.correct_answer::jsonb;
          IF jsonb_typeof(v_effective_answers -> v_q.id) = 'object' THEN
            v_student_map := v_effective_answers -> v_q.id;
          ELSIF v_ans_text IS NOT NULL AND LEFT(TRIM(v_ans_text), 1) = '{' THEN
            v_student_map := v_ans_text::jsonb;
          ELSE
            v_student_map := '{}'::jsonb;
          END IF;

          v_pair_total := 0;
          v_pair_matched := 0;
          FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_correct_map)
          LOOP
            v_pair_total := v_pair_total + 1;
            IF (v_student_map ->> v_kv.key) = v_kv.value THEN
              v_pair_matched := v_pair_matched + 1;
            END IF;
          END LOOP;

          IF v_pair_total > 0 THEN
            v_earned_points := v_earned_points + (v_q.pts::NUMERIC * v_pair_matched::NUMERIC / v_pair_total::NUMERIC);
            IF v_pair_matched = v_pair_total THEN
              v_correct := v_correct + 1;
            END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      ELSE
        IF v_ans_text = v_q.correct_answer THEN
          v_correct := v_correct + 1;
          v_earned_points := v_earned_points + v_q.pts;
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Fallback jika question_ids tidak cocok atau kosong: gunakan GIN index (@>) + subject index
  IF v_total_q = 0 THEN
    FOR v_q IN
      SELECT q.id, COALESCE(q.question_type, 'multiple_choice') AS q_type, q.correct_answer, COALESCE(q.points, 1) AS pts
      FROM public.questions q
      WHERE q.target_classes @> ARRAY[p_class_name]
        AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject))
    LOOP
      v_total_q := v_total_q + 1;
      v_total_points := v_total_points + v_q.pts;
      v_ans_text := v_effective_answers ->> v_q.id;

      IF v_q.q_type = 'matching' OR LEFT(TRIM(v_q.correct_answer), 1) = '{' THEN
        BEGIN
          v_correct_map := v_q.correct_answer::jsonb;
          IF jsonb_typeof(v_effective_answers -> v_q.id) = 'object' THEN
            v_student_map := v_effective_answers -> v_q.id;
          ELSIF v_ans_text IS NOT NULL AND LEFT(TRIM(v_ans_text), 1) = '{' THEN
            v_student_map := v_ans_text::jsonb;
          ELSE
            v_student_map := '{}'::jsonb;
          END IF;

          v_pair_total := 0;
          v_pair_matched := 0;
          FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_correct_map)
          LOOP
            v_pair_total := v_pair_total + 1;
            IF (v_student_map ->> v_kv.key) = v_kv.value THEN
              v_pair_matched := v_pair_matched + 1;
            END IF;
          END LOOP;

          IF v_pair_total > 0 THEN
            v_earned_points := v_earned_points + (v_q.pts::NUMERIC * v_pair_matched::NUMERIC / v_pair_total::NUMERIC);
            IF v_pair_matched = v_pair_total THEN
              v_correct := v_correct + 1;
            END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      ELSE
        IF v_ans_text = v_q.correct_answer THEN
          v_correct := v_correct + 1;
          v_earned_points := v_earned_points + v_q.pts;
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF v_total_points > 0 THEN
    v_score := ROUND((v_earned_points / v_total_points) * 100, 2);
  END IF;

  v_target_status := CASE WHEN v_effective_tab_switches >= v_effective_max_tabs THEN 'flagged' ELSE 'submitted' END;

  IF v_reconcile_auto_expired THEN
    UPDATE public.exam_results SET
      answers = v_effective_answers,
      flagged_questions = COALESCE(p_flagged_questions, public.exam_results.flagged_questions),
      question_ids = COALESCE(public.exam_results.question_ids, v_effective_question_ids),
      correct_count = CASE WHEN v_total_q > 0 THEN v_correct ELSE public.exam_results.correct_count END,
      total_questions = CASE WHEN v_total_q > 0 THEN v_total_q ELSE public.exam_results.total_questions END,
      score = CASE WHEN v_total_q > 0 THEN v_score ELSE public.exam_results.score END,
      tab_switch_count = GREATEST(public.exam_results.tab_switch_count, v_effective_tab_switches),
      status = CASE
        WHEN GREATEST(public.exam_results.tab_switch_count, v_effective_tab_switches) >= v_effective_max_tabs THEN 'flagged'
        ELSE 'submitted'
      END,
      finalized_by = 'student_reconciled',
      updated_at = NOW()
    WHERE id = v_existing.id
      AND finalized_by = 'auto_expired';

    IF NOT FOUND THEN
      RETURN QUERY
        SELECT er.correct_count, er.total_questions, er.score
        FROM public.exam_results er
        WHERE er.participant_number = v_norm_participant
          AND er.exam_id = p_exam_id
        LIMIT 1;
      RETURN;
    END IF;

    RETURN QUERY SELECT v_correct, v_total_q, v_score;
    RETURN;
  END IF;

  -- Penulisan atomik tunggal: row lock hanya dipegang sekejap saat INSERT/UPDATE akhir
  INSERT INTO public.exam_results (
    id, participant_id, participant_number, student_name, class_name,
    exam_id, exam_title, subject, answers, flagged_questions, question_ids,
    correct_count, total_questions, score, tab_switch_count,
    status, started_at, submitted_at, finalized_by, updated_at
  )
  VALUES (
    COALESCE(v_existing.id, p_result_id), p_participant_id, v_norm_participant, p_student_name, p_class_name,
    p_exam_id, p_exam_title, COALESCE(NULLIF(TRIM(v_effective_subject), ''), COALESCE(p_subject, '')),
    v_effective_answers, COALESCE(p_flagged_questions, '{}'::text[]), v_effective_question_ids,
    v_correct, v_total_q, v_score, v_effective_tab_switches,
    v_target_status, COALESCE(p_started_at, NOW()), NOW(), 'student', NOW()
  )
  ON CONFLICT (participant_number, exam_id) DO UPDATE SET
    answers = EXCLUDED.answers,
    flagged_questions = EXCLUDED.flagged_questions,
    question_ids = COALESCE(public.exam_results.question_ids, EXCLUDED.question_ids),
    correct_count = EXCLUDED.correct_count,
    total_questions = EXCLUDED.total_questions,
    score = EXCLUDED.score,
    tab_switch_count = GREATEST(public.exam_results.tab_switch_count, EXCLUDED.tab_switch_count),
    status = CASE
      WHEN GREATEST(public.exam_results.tab_switch_count, EXCLUDED.tab_switch_count) >= v_effective_max_tabs THEN 'flagged'
      ELSE 'submitted'
    END,
    submitted_at = NOW(),
    finalized_by = 'student',
    updated_at = NOW()
  WHERE public.exam_results.status = 'in_progress'
    AND public.exam_results.submitted_at IS NULL;

  IF NOT FOUND THEN
    RETURN QUERY
      SELECT er.correct_count, er.total_questions, er.score
      FROM public.exam_results er
      WHERE er.participant_number = v_norm_participant
        AND er.exam_id = p_exam_id
      LIMIT 1;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_correct, v_total_q, v_score;
END;
$$;

-- Fungsi RPC Admin untuk menyimpan & menghapus soal tanpa membuka SELECT langsung tabel questions
DROP FUNCTION IF EXISTS public.upsert_questions_batch(JSONB);
DROP FUNCTION IF EXISTS public.upsert_questions_batch(JSONB, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.upsert_questions_batch(
  p_questions JSONB,
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item JSONB;
  v_id TEXT;
  v_target_classes TEXT[];
  v_points INTEGER;
  v_order_idx INTEGER;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions');

  IF p_questions IS NULL OR jsonb_typeof(p_questions) <> 'array' THEN
    RETURN;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_questions)
  LOOP
    IF item IS NULL OR jsonb_typeof(item) <> 'object' THEN
      CONTINUE;
    END IF;

    v_id := NULLIF(TRIM(COALESCE(item ->> 'id', '')), '');
    IF v_id IS NULL THEN
      CONTINUE;
    END IF;

    v_target_classes := CASE
      WHEN jsonb_typeof(item -> 'target_classes') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(item -> 'target_classes'))
      ELSE '{}'::TEXT[]
    END;

    v_points := CASE
      WHEN COALESCE(item ->> 'points', '') ~ '^[0-9]+$' THEN GREATEST((item ->> 'points')::INTEGER, 1)
      ELSE 1
    END;

    v_order_idx := CASE
      WHEN COALESCE(item ->> 'order_index', '') ~ '^[0-9]+$' THEN GREATEST((item ->> 'order_index')::INTEGER, 1)
      ELSE 1
    END;

    INSERT INTO public.questions (
      id, subject, target_classes, question_type, question_text, question_image_url,
      options, matching_pairs, correct_answer, points, order_index, updated_at
    )
    VALUES (
      v_id,
      COALESCE(item ->> 'subject', ''),
      v_target_classes,
      COALESCE(NULLIF(item ->> 'question_type', ''), 'multiple_choice'),
      COALESCE(item ->> 'question_text', ''),
      COALESCE(item ->> 'question_image_url', ''),
      COALESCE(item -> 'options', '[]'::jsonb),
      CASE WHEN item ? 'matching_pairs' AND jsonb_typeof(item -> 'matching_pairs') <> 'null' THEN item -> 'matching_pairs' ELSE NULL END,
      COALESCE(item ->> 'correct_answer', 'A'),
      v_points,
      v_order_idx,
      NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      subject = EXCLUDED.subject,
      target_classes = EXCLUDED.target_classes,
      question_type = EXCLUDED.question_type,
      question_text = EXCLUDED.question_text,
      question_image_url = EXCLUDED.question_image_url,
      options = EXCLUDED.options,
      matching_pairs = EXCLUDED.matching_pairs,
      correct_answer = EXCLUDED.correct_answer,
      points = EXCLUDED.points,
      order_index = EXCLUDED.order_index,
      updated_at = NOW();
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS public.get_questions_sync_meta();
DROP FUNCTION IF EXISTS public.get_questions_sync_meta(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_questions_sync_meta(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS TABLE (
  total_count BIGINT,
  max_updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, NULL);
  RETURN QUERY SELECT COUNT(*)::BIGINT, MAX(q.updated_at) FROM public.questions q;
END;
$$;

DROP FUNCTION IF EXISTS public.get_question_coverage_summary();
DROP FUNCTION IF EXISTS public.get_question_coverage_summary(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_question_coverage_summary(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  subject TEXT,
  target_classes TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions');
  RETURN QUERY
    SELECT q.id, q.subject, q.target_classes
    FROM public.questions q
    ORDER BY q.subject ASC, q.order_index ASC, q.id ASC;
END;
$$;

DROP FUNCTION IF EXISTS public.delete_question_by_id(TEXT);
DROP FUNCTION IF EXISTS public.delete_question_by_id(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.delete_question_by_id(
  p_id TEXT,
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions');
  DELETE FROM public.questions WHERE id = p_id;
END;
$$;

-- Penilaian otomatis batch di server untuk sesi yang kedaluwarsa (LIMIT 50 per panggilan untuk mencegah timeout)
DROP FUNCTION IF EXISTS public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER);
DROP FUNCTION IF EXISTS public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER, INTEGER, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.auto_finalize_expired_results(
  p_exam_id TEXT,
  p_cutoff TIMESTAMPTZ,
  p_max_tab_switches INTEGER DEFAULT 3,
  p_limit INTEGER DEFAULT 50,
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
  v_row RECORD;
  v_sched_subject TEXT;
  v_sched_max_tabs INTEGER;
  v_effective_subject TEXT;
  v_effective_max_tabs INTEGER;
  v_effective_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_total_points NUMERIC;
  v_earned_points NUMERIC;
  v_correct INTEGER;
  v_total_q INTEGER;
  v_score NUMERIC(5,2);
  v_q RECORD;
  v_ans_text TEXT;
  v_correct_map JSONB;
  v_student_map JSONB;
  v_pair_total INTEGER;
  v_pair_matched INTEGER;
  v_kv RECORD;
  v_finalized_count INTEGER := 0;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, NULL);

  SELECT s.subject, s.max_tab_switches
  INTO v_sched_subject, v_sched_max_tabs
  FROM public.exam_schedules s
  WHERE s.id = p_exam_id
  LIMIT 1;

  v_effective_max_tabs := COALESCE(v_sched_max_tabs, p_max_tab_switches, 3);

  FOR v_row IN
    SELECT er.*
    FROM public.exam_results er
    WHERE er.exam_id = p_exam_id
      AND er.status = 'in_progress'
      AND er.submitted_at IS NULL
      AND er.started_at <= p_cutoff
    ORDER BY er.started_at ASC
    LIMIT v_effective_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_total_points := 0;
    v_earned_points := 0;
    v_correct := 0;
    v_total_q := 0;
    v_score := 0;
    v_effective_subject := COALESCE(NULLIF(TRIM(v_sched_subject), ''), NULLIF(TRIM(v_row.subject), ''), '');

    FOR v_q IN
      SELECT q.id, COALESCE(q.question_type, 'multiple_choice') AS q_type, q.correct_answer, COALESCE(q.points, 1) AS pts
      FROM public.questions q
      WHERE q.target_classes @> ARRAY[v_row.class_name]
        AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject))
        AND (v_row.question_ids IS NULL OR array_length(v_row.question_ids, 1) IS NULL OR q.id = ANY(v_row.question_ids))
    LOOP
      v_total_q := v_total_q + 1;
      v_total_points := v_total_points + v_q.pts;
      v_ans_text := v_row.answers ->> v_q.id;

      IF v_q.q_type = 'matching' OR LEFT(TRIM(v_q.correct_answer), 1) = '{' THEN
        BEGIN
          v_correct_map := v_q.correct_answer::jsonb;
          IF jsonb_typeof(v_row.answers -> v_q.id) = 'object' THEN
            v_student_map := v_row.answers -> v_q.id;
          ELSIF v_ans_text IS NOT NULL AND LEFT(TRIM(v_ans_text), 1) = '{' THEN
            v_student_map := v_ans_text::jsonb;
          ELSE
            v_student_map := '{}'::jsonb;
          END IF;

          v_pair_total := 0;
          v_pair_matched := 0;
          FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_correct_map)
          LOOP
            v_pair_total := v_pair_total + 1;
            IF (v_student_map ->> v_kv.key) = v_kv.value THEN
              v_pair_matched := v_pair_matched + 1;
            END IF;
          END LOOP;

          IF v_pair_total > 0 THEN
            v_earned_points := v_earned_points + (v_q.pts::NUMERIC * v_pair_matched::NUMERIC / v_pair_total::NUMERIC);
            IF v_pair_matched = v_pair_total THEN
              v_correct := v_correct + 1;
            END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      ELSE
        IF v_ans_text = v_q.correct_answer THEN
          v_correct := v_correct + 1;
          v_earned_points := v_earned_points + v_q.pts;
        END IF;
      END IF;
    END LOOP;

    -- Fallback jika question_ids usang/terganti sehingga query awal menghasilkan 0 soal
    IF v_total_q = 0 AND v_row.question_ids IS NOT NULL AND array_length(v_row.question_ids, 1) IS NOT NULL THEN
      FOR v_q IN
        SELECT q.id, COALESCE(q.question_type, 'multiple_choice') AS q_type, q.correct_answer, COALESCE(q.points, 1) AS pts
        FROM public.questions q
        WHERE q.target_classes @> ARRAY[v_row.class_name]
          AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject))
      LOOP
        v_total_q := v_total_q + 1;
        v_total_points := v_total_points + v_q.pts;
        v_ans_text := v_row.answers ->> v_q.id;

        IF v_q.q_type = 'matching' OR LEFT(TRIM(v_q.correct_answer), 1) = '{' THEN
          BEGIN
            v_correct_map := v_q.correct_answer::jsonb;
            IF jsonb_typeof(v_row.answers -> v_q.id) = 'object' THEN
              v_student_map := v_row.answers -> v_q.id;
            ELSIF v_ans_text IS NOT NULL AND LEFT(TRIM(v_ans_text), 1) = '{' THEN
              v_student_map := v_ans_text::jsonb;
            ELSE
              v_student_map := '{}'::jsonb;
            END IF;

            v_pair_total := 0;
            v_pair_matched := 0;
            FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_correct_map)
            LOOP
              v_pair_total := v_pair_total + 1;
              IF (v_student_map ->> v_kv.key) = v_kv.value THEN
                v_pair_matched := v_pair_matched + 1;
              END IF;
            END LOOP;

            IF v_pair_total > 0 THEN
              v_earned_points := v_earned_points + (v_q.pts::NUMERIC * v_pair_matched::NUMERIC / v_pair_total::NUMERIC);
              IF v_pair_matched = v_pair_total THEN
                v_correct := v_correct + 1;
              END IF;
            END IF;
          EXCEPTION WHEN OTHERS THEN
            NULL;
          END;
        ELSE
          IF v_ans_text = v_q.correct_answer THEN
            v_correct := v_correct + 1;
            v_earned_points := v_earned_points + v_q.pts;
          END IF;
        END IF;
      END LOOP;
    END IF;

    IF v_total_q > 0 THEN
      IF v_total_points > 0 THEN
        v_score := ROUND((v_earned_points / v_total_points) * 100, 2);
      END IF;

      UPDATE public.exam_results SET
        correct_count = v_correct,
        total_questions = v_total_q,
        score = v_score,
        status = CASE WHEN v_row.tab_switch_count >= v_effective_max_tabs THEN 'flagged' ELSE 'submitted' END,
        submitted_at = NOW(),
        finalized_by = 'auto_expired',
        updated_at = NOW()
      WHERE id = v_row.id
        AND status = 'in_progress'
        AND submitted_at IS NULL;

      IF FOUND THEN
        v_finalized_count := v_finalized_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_finalized_count;
END;
$$;

-- Paksa-selesai & penilaian batch di server untuk daftar ID hasil ujian (aman terhadap timeout RLS/Statement)
DROP FUNCTION IF EXISTS public.force_finish_exam_results(TEXT[], INTEGER);
DROP FUNCTION IF EXISTS public.force_finish_exam_results(TEXT[], INTEGER, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.force_finish_exam_results(
  p_result_ids TEXT[],
  p_limit INTEGER DEFAULT 50,
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '30s'
AS $$
DECLARE
  v_row RECORD;
  v_sched_subject TEXT;
  v_sched_max_tabs INTEGER;
  v_effective_subject TEXT;
  v_effective_max_tabs INTEGER;
  v_effective_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_total_points NUMERIC;
  v_earned_points NUMERIC;
  v_correct INTEGER;
  v_total_q INTEGER;
  v_score NUMERIC(5,2);
  v_q RECORD;
  v_ans_text TEXT;
  v_correct_map JSONB;
  v_student_map JSONB;
  v_pair_total INTEGER;
  v_pair_matched INTEGER;
  v_kv RECORD;
  v_finished_count INTEGER := 0;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, NULL);

  IF p_result_ids IS NULL OR array_length(p_result_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_row IN
    SELECT er.*
    FROM public.exam_results er
    WHERE er.id = ANY(p_result_ids)
      AND er.status = 'in_progress'
      AND er.submitted_at IS NULL
    ORDER BY er.started_at ASC
    LIMIT v_effective_limit
    FOR UPDATE SKIP LOCKED
  LOOP
    v_sched_subject := NULL;
    v_sched_max_tabs := NULL;

    -- Prioritaskan exam_id, lalu fallback subject jika jadwal lama terhapus
    SELECT s.subject, s.max_tab_switches
    INTO v_sched_subject, v_sched_max_tabs
    FROM public.exam_schedules s
    WHERE s.id = v_row.exam_id
    LIMIT 1;

    IF NOT FOUND AND v_row.subject IS NOT NULL AND TRIM(v_row.subject) <> '' THEN
      SELECT s.subject, s.max_tab_switches
      INTO v_sched_subject, v_sched_max_tabs
      FROM public.exam_schedules s
      WHERE LOWER(TRIM(s.subject)) = LOWER(TRIM(v_row.subject))
      LIMIT 1;
    END IF;

    v_effective_subject := COALESCE(NULLIF(TRIM(v_sched_subject), ''), NULLIF(TRIM(v_row.subject), ''), '');
    v_effective_max_tabs := COALESCE(v_sched_max_tabs, 3);
    v_total_points := 0;
    v_earned_points := 0;
    v_correct := 0;
    v_total_q := 0;
    v_score := 0;

    FOR v_q IN
      SELECT q.id, COALESCE(q.question_type, 'multiple_choice') AS q_type, q.correct_answer, COALESCE(q.points, 1) AS pts
      FROM public.questions q
      WHERE q.target_classes @> ARRAY[v_row.class_name]
        AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject))
        AND (v_row.question_ids IS NULL OR array_length(v_row.question_ids, 1) IS NULL OR q.id = ANY(v_row.question_ids))
    LOOP
      v_total_q := v_total_q + 1;
      v_total_points := v_total_points + v_q.pts;
      v_ans_text := v_row.answers ->> v_q.id;

      IF v_q.q_type = 'matching' OR LEFT(TRIM(v_q.correct_answer), 1) = '{' THEN
        BEGIN
          v_correct_map := v_q.correct_answer::jsonb;
          IF jsonb_typeof(v_row.answers -> v_q.id) = 'object' THEN
            v_student_map := v_row.answers -> v_q.id;
          ELSIF v_ans_text IS NOT NULL AND LEFT(TRIM(v_ans_text), 1) = '{' THEN
            v_student_map := v_ans_text::jsonb;
          ELSE
            v_student_map := '{}'::jsonb;
          END IF;

          v_pair_total := 0;
          v_pair_matched := 0;
          FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_correct_map)
          LOOP
            v_pair_total := v_pair_total + 1;
            IF (v_student_map ->> v_kv.key) = v_kv.value THEN
              v_pair_matched := v_pair_matched + 1;
            END IF;
          END LOOP;

          IF v_pair_total > 0 THEN
            v_earned_points := v_earned_points + (v_q.pts::NUMERIC * v_pair_matched::NUMERIC / v_pair_total::NUMERIC);
            IF v_pair_matched = v_pair_total THEN
              v_correct := v_correct + 1;
            END IF;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      ELSE
        IF v_ans_text = v_q.correct_answer THEN
          v_correct := v_correct + 1;
          v_earned_points := v_earned_points + v_q.pts;
        END IF;
      END IF;
    END LOOP;

    -- Fallback jika question_ids usang/terganti (mencegah vonis skor 0 permanen saat Paksa Selesai)
    IF v_total_q = 0 AND v_row.question_ids IS NOT NULL AND array_length(v_row.question_ids, 1) IS NOT NULL THEN
      FOR v_q IN
        SELECT q.id, COALESCE(q.question_type, 'multiple_choice') AS q_type, q.correct_answer, COALESCE(q.points, 1) AS pts
        FROM public.questions q
        WHERE q.target_classes @> ARRAY[v_row.class_name]
          AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject))
      LOOP
        v_total_q := v_total_q + 1;
        v_total_points := v_total_points + v_q.pts;
        v_ans_text := v_row.answers ->> v_q.id;

        IF v_q.q_type = 'matching' OR LEFT(TRIM(v_q.correct_answer), 1) = '{' THEN
          BEGIN
            v_correct_map := v_q.correct_answer::jsonb;
            IF jsonb_typeof(v_row.answers -> v_q.id) = 'object' THEN
              v_student_map := v_row.answers -> v_q.id;
            ELSIF v_ans_text IS NOT NULL AND LEFT(TRIM(v_ans_text), 1) = '{' THEN
              v_student_map := v_ans_text::jsonb;
            ELSE
              v_student_map := '{}'::jsonb;
            END IF;

            v_pair_total := 0;
            v_pair_matched := 0;
            FOR v_kv IN SELECT key, value FROM jsonb_each_text(v_correct_map)
            LOOP
              v_pair_total := v_pair_total + 1;
              IF (v_student_map ->> v_kv.key) = v_kv.value THEN
                v_pair_matched := v_pair_matched + 1;
              END IF;
            END LOOP;

            IF v_pair_total > 0 THEN
              v_earned_points := v_earned_points + (v_q.pts::NUMERIC * v_pair_matched::NUMERIC / v_pair_total::NUMERIC);
              IF v_pair_matched = v_pair_total THEN
                v_correct := v_correct + 1;
              END IF;
            END IF;
          EXCEPTION WHEN OTHERS THEN
            NULL;
          END;
        ELSE
          IF v_ans_text = v_q.correct_answer THEN
            v_correct := v_correct + 1;
            v_earned_points := v_earned_points + v_q.pts;
          END IF;
        END IF;
      END LOOP;
    END IF;

    -- Guard wajib: jangan pernah mengunci skor 0 permanen jika bank soal tidak ditemukan (v_total_q = 0)
    IF v_total_q > 0 THEN
      IF v_total_points > 0 THEN
        v_score := ROUND((v_earned_points / v_total_points) * 100, 2);
      END IF;

      UPDATE public.exam_results SET
        correct_count = v_correct,
        total_questions = v_total_q,
        score = v_score,
        status = CASE WHEN v_row.tab_switch_count >= v_effective_max_tabs THEN 'flagged' ELSE 'submitted' END,
        submitted_at = NOW(),
        finalized_by = 'staff_force',
        updated_at = NOW()
      WHERE id = v_row.id
        AND status = 'in_progress'
        AND submitted_at IS NULL;

      IF FOUND THEN
        v_finished_count := v_finished_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_finished_count;
END;
$$;

-- Verifikasi login peserta & staf di server-side RPC agar kredensial tidak perlu ditarik penuh
CREATE OR REPLACE FUNCTION public.verify_participant_login(
  p_participant_number TEXT,
  p_token TEXT
)
RETURNS TABLE (
  status TEXT,
  id TEXT,
  participant_number TEXT,
  token TEXT,
  full_name TEXT,
  class_name TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_norm_tok TEXT := UPPER(TRIM(COALESCE(p_token, '')));
  v_rec public.participants%ROWTYPE;
BEGIN
  IF v_norm_num = '' THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  -- Lookup langsung via UNIQUE index participant_number terlebih dahulu agar tidak Seq Scan saat 800 siswa login
  SELECT * INTO v_rec
  FROM public.participants p
  WHERE p.participant_number = v_norm_num
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT * INTO v_rec
    FROM public.participants p
    WHERE UPPER(TRIM(p.participant_number)) = v_norm_num
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT COALESCE(v_rec.is_active, FALSE) THEN
    RETURN QUERY SELECT 'inactive'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, FALSE::BOOLEAN, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF UPPER(TRIM(COALESCE(v_rec.token, ''))) <> v_norm_tok THEN
    RETURN QUERY SELECT 'wrong_token'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    'ok'::TEXT, v_rec.id, UPPER(TRIM(v_rec.participant_number)), v_rec.token,
    v_rec.full_name, v_rec.class_name, v_rec.is_active, v_rec.created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_staff_login(
  p_user_id TEXT,
  p_password_plain TEXT,
  p_password_sha256 TEXT
)
RETURNS TABLE (
  ok BOOLEAN,
  id TEXT,
  user_id TEXT,
  name TEXT,
  role_type TEXT,
  role_label TEXT,
  allowed_tabs TEXT[],
  assigned_subjects TEXT[],
  restrict_to_assigned_subjects BOOLEAN,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_norm_id TEXT := LOWER(TRIM(COALESCE(p_user_id, '')));
  v_plain TEXT := TRIM(COALESCE(p_password_plain, ''));
  v_sha TEXT := CASE
    WHEN TRIM(COALESCE(p_password_sha256, '')) <> '' THEN LOWER(TRIM(p_password_sha256))
    WHEN TRIM(COALESCE(p_password_plain, '')) <> '' THEN 'sha256$' || encode(pg_catalog.sha256(convert_to(TRIM(p_password_plain), 'UTF8')), 'hex')
    ELSE ''
  END;
  v_staff public.staff_accounts%ROWTYPE;
  v_stored TEXT;
  v_admin_pwd TEXT;
  v_matched BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_staff
  FROM public.staff_accounts s
  WHERE LOWER(TRIM(s.user_id)) = v_norm_id
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF NOT v_staff.is_active THEN
      RETURN QUERY SELECT FALSE, v_staff.id, v_staff.user_id, v_staff.name, v_staff.role_type, v_staff.role_label,
        v_staff.allowed_tabs, v_staff.assigned_subjects, v_staff.restrict_to_assigned_subjects, v_staff.is_active, v_staff.created_at,
        ('Akun dengan ID "' || v_staff.user_id || '" sedang dinonaktifkan oleh Administrator.')::TEXT;
      RETURN;
    END IF;

    v_stored := TRIM(COALESCE(v_staff.password_hash, ''));
    IF v_stored <> '' THEN
      IF LOWER(v_stored) = v_sha THEN
        v_matched := TRUE;
      ELSIF LEFT(v_sha, 7) = 'sha256$'
            AND LENGTH(v_stored) = 64
            AND LOWER(v_stored) = SUBSTRING(v_sha FROM 8) THEN
        v_matched := TRUE;
      ELSIF LEFT(LOWER(v_stored), 7) <> 'sha256$' THEN
        IF v_stored = v_plain
           OR ('sha256$' || encode(pg_catalog.sha256(convert_to(v_stored, 'UTF8')), 'hex')) = v_sha THEN
          v_matched := TRUE;
        END IF;
      END IF;
    ELSIF v_norm_id = 'admin' THEN
      SELECT sp.admin_password INTO v_admin_pwd FROM public.school_profile sp WHERE sp.id = 'default' LIMIT 1;
      v_stored := TRIM(COALESCE(v_admin_pwd, ''));
      IF v_stored <> '' THEN
        IF LOWER(v_stored) = v_sha THEN
          v_matched := TRUE;
        ELSIF LEFT(v_sha, 7) = 'sha256$'
              AND LENGTH(v_stored) = 64
              AND LOWER(v_stored) = SUBSTRING(v_sha FROM 8) THEN
          v_matched := TRUE;
        ELSIF LEFT(LOWER(v_stored), 7) <> 'sha256$' THEN
          IF v_stored = v_plain
             OR ('sha256$' || encode(pg_catalog.sha256(convert_to(v_stored, 'UTF8')), 'hex')) = v_sha THEN
            v_matched := TRUE;
          END IF;
        END IF;
      END IF;
    END IF;

    IF v_matched THEN
      RETURN QUERY SELECT TRUE, v_staff.id, v_staff.user_id, v_staff.name, v_staff.role_type, v_staff.role_label,
        v_staff.allowed_tabs, v_staff.assigned_subjects, v_staff.restrict_to_assigned_subjects, v_staff.is_active, v_staff.created_at,
        NULL::TEXT;
      RETURN;
    END IF;

    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
      NULL::TEXT[], NULL::TEXT[], NULL::BOOLEAN, NULL::BOOLEAN, NULL::TIMESTAMPTZ,
      'Sandi / PIN tidak sesuai.'::TEXT;
    RETURN;
  END IF;

  IF v_norm_id = 'admin' THEN
    SELECT sp.admin_password INTO v_admin_pwd FROM public.school_profile sp WHERE sp.id = 'default' LIMIT 1;
    v_stored := TRIM(COALESCE(v_admin_pwd, ''));
    IF v_stored <> '' THEN
      IF LOWER(v_stored) = v_sha THEN
        v_matched := TRUE;
      ELSIF LEFT(v_sha, 7) = 'sha256$'
            AND LENGTH(v_stored) = 64
            AND LOWER(v_stored) = SUBSTRING(v_sha FROM 8) THEN
        v_matched := TRUE;
      ELSIF LEFT(LOWER(v_stored), 7) <> 'sha256$' THEN
        IF v_stored = v_plain
           OR ('sha256$' || encode(pg_catalog.sha256(convert_to(v_stored, 'UTF8')), 'hex')) = v_sha THEN
          v_matched := TRUE;
        END IF;
      END IF;

      IF v_matched THEN
        RETURN QUERY SELECT TRUE, 'staff-admin'::TEXT, 'admin'::TEXT, 'Administrator Utama'::TEXT, 'admin'::TEXT, 'Administrator'::TEXT,
          ARRAY['dashboard','branding','participants','questions','cards','reset','recap','roles','database']::TEXT[],
          ARRAY[]::TEXT[], FALSE, TRUE, NOW(), NULL::TEXT;
        RETURN;
      END IF;

      RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
        NULL::TEXT[], NULL::TEXT[], NULL::BOOLEAN, NULL::BOOLEAN, NULL::TIMESTAMPTZ,
        'Sandi / PIN tidak sesuai.'::TEXT;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT,
    NULL::TEXT[], NULL::TEXT[], NULL::BOOLEAN, NULL::BOOLEAN, NULL::TIMESTAMPTZ,
    'not_found'::TEXT;
END;
$$;

-- RPC Admin Aman (tanpa membuka SELECT/WRITE langsung tabel sensitif ke anon)
CREATE OR REPLACE FUNCTION public.staff_list_accounts(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  user_id TEXT,
  name TEXT,
  role_type TEXT,
  role_label TEXT,
  allowed_tabs TEXT[],
  assigned_subjects TEXT[],
  restrict_to_assigned_subjects BOOLEAN,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'roles');
  RETURN QUERY
    SELECT s.id, s.user_id, s.name, s.role_type, s.role_label, s.allowed_tabs,
           s.assigned_subjects, s.restrict_to_assigned_subjects, s.is_active, s.created_at
    FROM public.staff_accounts s
    ORDER BY s.created_at ASC, s.user_id ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_upsert_account(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_id TEXT,
  p_target_user_id TEXT,
  p_name TEXT,
  p_password_hash TEXT,
  p_role_type TEXT,
  p_role_label TEXT,
  p_allowed_tabs TEXT[],
  p_assigned_subjects TEXT[],
  p_restrict_to_assigned_subjects BOOLEAN,
  p_is_active BOOLEAN,
  p_created_at TIMESTAMPTZ DEFAULT NOW()
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_clean_uid TEXT := TRIM(COALESCE(p_target_user_id, ''));
  v_clean_pwd TEXT := NULLIF(TRIM(COALESCE(p_password_hash, '')), '');
  v_existing public.staff_accounts%ROWTYPE;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'roles');

  IF v_clean_uid = '' THEN
    RAISE EXCEPTION 'Target user_id is required';
  END IF;

  IF v_clean_pwd = '__CLOUD_MANAGED__' THEN
    v_clean_pwd := NULL;
  END IF;

  SELECT * INTO v_existing
  FROM public.staff_accounts s
  WHERE s.id = p_id OR LOWER(TRIM(s.user_id)) = LOWER(v_clean_uid)
  ORDER BY CASE WHEN s.id = p_id THEN 0 ELSE 1 END
  LIMIT 1;

  IF FOUND THEN
    -- Hapus duplikat beda kapitalisasi (mis. PROKTOR2 vs proktor2) agar tidak ada sandi lama tersisa
    DELETE FROM public.staff_accounts
    WHERE LOWER(TRIM(user_id)) = LOWER(v_clean_uid)
      AND id <> v_existing.id;

    UPDATE public.staff_accounts SET
      user_id = v_clean_uid,
      name = TRIM(COALESCE(p_name, '')),
      password_hash = COALESCE(v_clean_pwd, public.staff_accounts.password_hash),
      role_type = COALESCE(p_role_type, 'guru_mapel'),
      role_label = COALESCE(p_role_label, 'Staff'),
      allowed_tabs = COALESCE(p_allowed_tabs, '{}'::TEXT[]),
      assigned_subjects = COALESCE(p_assigned_subjects, '{}'::TEXT[]),
      restrict_to_assigned_subjects = COALESCE(p_restrict_to_assigned_subjects, FALSE),
      is_active = COALESCE(p_is_active, TRUE)
    WHERE id = v_existing.id;
  ELSE
    INSERT INTO public.staff_accounts (
      id, user_id, name, password_hash, role_type, role_label,
      allowed_tabs, assigned_subjects, restrict_to_assigned_subjects, is_active, created_at
    )
    VALUES (
      p_id, v_clean_uid, TRIM(COALESCE(p_name, '')), COALESCE(v_clean_pwd, ''),
      COALESCE(p_role_type, 'guru_mapel'), COALESCE(p_role_label, 'Staff'),
      COALESCE(p_allowed_tabs, '{}'::TEXT[]), COALESCE(p_assigned_subjects, '{}'::TEXT[]),
      COALESCE(p_restrict_to_assigned_subjects, FALSE), COALESCE(p_is_active, TRUE),
      COALESCE(p_created_at, NOW())
    );
  END IF;

  -- Sinkronkan sandi admin utama secara atomik ke school_profile
  IF LOWER(v_clean_uid) = 'admin' AND v_clean_pwd IS NOT NULL AND v_clean_pwd <> '' THEN
    UPDATE public.school_profile
    SET admin_password = v_clean_pwd, updated_at = NOW()
    WHERE id = 'default';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_delete_account(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_target_id TEXT,
  p_target_user_id TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'roles');
  IF LOWER(TRIM(COALESCE(p_target_user_id, ''))) = 'admin' THEN
    RETURN;
  END IF;
  DELETE FROM public.staff_accounts
  WHERE (id = p_target_id OR (p_target_user_id IS NOT NULL AND LOWER(TRIM(user_id)) = LOWER(TRIM(p_target_user_id))))
    AND LOWER(TRIM(user_id)) <> 'admin';
END;
$$;

DROP FUNCTION IF EXISTS public.staff_upsert_school_profile(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION public.staff_upsert_school_profile(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_school_name TEXT,
  p_address TEXT,
  p_academic_year TEXT,
  p_principal_name TEXT,
  p_committee_chair_name TEXT,
  p_exam_title TEXT,
  p_logo_data_url TEXT,
  p_admin_password_hash TEXT DEFAULT NULL,
  p_updated_at TIMESTAMPTZ DEFAULT NOW(),
  p_kemenag_logo_data_url TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_existing_pwd TEXT;
  v_clean_pwd TEXT := NULLIF(TRIM(COALESCE(p_admin_password_hash, '')), '');
  v_next_pwd TEXT;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'branding');
  IF v_clean_pwd = '__CLOUD_MANAGED__' THEN
    v_clean_pwd := NULL;
  END IF;

  SELECT sp.admin_password INTO v_existing_pwd FROM public.school_profile sp WHERE sp.id = 'default' LIMIT 1;
  v_next_pwd := COALESCE(v_clean_pwd, v_existing_pwd, 'admin123');

  INSERT INTO public.school_profile (
    id, school_name, address, academic_year, principal_name, committee_chair_name,
    exam_title, logo_data_url, kemenag_logo_data_url, admin_password, updated_at
  )
  VALUES (
    'default', COALESCE(p_school_name, ''), COALESCE(p_address, ''), COALESCE(p_academic_year, ''),
    COALESCE(p_principal_name, ''), COALESCE(p_committee_chair_name, ''), COALESCE(p_exam_title, ''),
    COALESCE(p_logo_data_url, ''), COALESCE(p_kemenag_logo_data_url, ''), v_next_pwd, COALESCE(p_updated_at, NOW())
  )
  ON CONFLICT (id) DO UPDATE SET
    school_name = EXCLUDED.school_name,
    address = EXCLUDED.address,
    academic_year = EXCLUDED.academic_year,
    principal_name = EXCLUDED.principal_name,
    committee_chair_name = EXCLUDED.committee_chair_name,
    exam_title = EXCLUDED.exam_title,
    logo_data_url = EXCLUDED.logo_data_url,
    kemenag_logo_data_url = CASE
      WHEN p_kemenag_logo_data_url IS NOT NULL THEN p_kemenag_logo_data_url
      ELSE public.school_profile.kemenag_logo_data_url
    END,
    admin_password = CASE
      WHEN v_clean_pwd IS NOT NULL THEN v_clean_pwd
      ELSE public.school_profile.admin_password
    END,
    updated_at = EXCLUDED.updated_at;

  -- Sinkronkan sandi admin baru secara atomik ke staff_accounts
  IF v_clean_pwd IS NOT NULL THEN
    UPDATE public.staff_accounts
    SET password_hash = v_clean_pwd
    WHERE LOWER(TRIM(user_id)) = 'admin';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_delete_exam_results(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_result_ids TEXT[] DEFAULT NULL,
  p_participant_number TEXT DEFAULT NULL,
  p_exam_id TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER := 0;
  v_rows INTEGER := 0;
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, NULL);

  IF p_result_ids IS NOT NULL AND array_length(p_result_ids, 1) IS NOT NULL THEN
    DELETE FROM public.exam_results WHERE id = ANY(p_result_ids);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_deleted := v_deleted + v_rows;
  END IF;

  IF v_norm_num <> '' AND COALESCE(TRIM(p_exam_id), '') <> '' THEN
    DELETE FROM public.exam_results
    WHERE UPPER(TRIM(participant_number)) = v_norm_num
      AND exam_id = p_exam_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_deleted := v_deleted + v_rows;
  END IF;

  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_upsert_exam_results_batch(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_results JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item JSONB;
  v_count INTEGER := 0;
  v_norm_num TEXT;
  v_flagged TEXT[];
  v_q_ids TEXT[];
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'database');

  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_results)
  LOOP
    IF item IS NULL OR jsonb_typeof(item) <> 'object' THEN
      CONTINUE;
    END IF;
    v_norm_num := UPPER(TRIM(COALESCE(item ->> 'participant_number', '')));
    IF COALESCE(TRIM(item ->> 'id'), '') = '' OR v_norm_num = '' OR COALESCE(TRIM(item ->> 'exam_id'), '') = '' THEN
      CONTINUE;
    END IF;

    v_flagged := CASE
      WHEN jsonb_typeof(item -> 'flagged_questions') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(item -> 'flagged_questions'))
      ELSE '{}'::TEXT[]
    END;

    v_q_ids := CASE
      WHEN jsonb_typeof(item -> 'question_ids') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(item -> 'question_ids'))
      ELSE NULL
    END;

    INSERT INTO public.exam_results (
      id, participant_id, participant_number, student_name, class_name,
      exam_id, exam_title, subject, answers, flagged_questions, question_ids,
      correct_count, total_questions, score, tab_switch_count,
      status, started_at, submitted_at, updated_at
    )
    VALUES (
      item ->> 'id',
      COALESCE(item ->> 'participant_id', ''),
      v_norm_num,
      COALESCE(item ->> 'student_name', ''),
      COALESCE(item ->> 'class_name', ''),
      item ->> 'exam_id',
      COALESCE(item ->> 'exam_title', ''),
      COALESCE(item ->> 'subject', ''),
      CASE WHEN jsonb_typeof(item -> 'answers') = 'object' THEN item -> 'answers' ELSE '{}'::jsonb END,
      v_flagged,
      v_q_ids,
      COALESCE((item ->> 'correct_count')::INTEGER, 0),
      COALESCE((item ->> 'total_questions')::INTEGER, 0),
      COALESCE((item ->> 'score')::NUMERIC(5,2), 0),
      COALESCE((item ->> 'tab_switch_count')::INTEGER, 0),
      CASE WHEN (item ->> 'status') IN ('in_progress', 'submitted', 'flagged') THEN item ->> 'status' ELSE 'in_progress' END,
      COALESCE((item ->> 'started_at')::TIMESTAMPTZ, NOW()),
      CASE WHEN NULLIF(item ->> 'submitted_at', '') IS NOT NULL THEN (item ->> 'submitted_at')::TIMESTAMPTZ ELSE NULL END,
      COALESCE((item ->> 'updated_at')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (participant_number, exam_id) DO UPDATE SET
      student_name = EXCLUDED.student_name,
      class_name = EXCLUDED.class_name,
      exam_title = EXCLUDED.exam_title,
      subject = EXCLUDED.subject,
      answers = EXCLUDED.answers,
      flagged_questions = EXCLUDED.flagged_questions,
      question_ids = COALESCE(EXCLUDED.question_ids, public.exam_results.question_ids),
      correct_count = EXCLUDED.correct_count,
      total_questions = EXCLUDED.total_questions,
      score = EXCLUDED.score,
      tab_switch_count = EXCLUDED.tab_switch_count,
      status = EXCLUDED.status,
      started_at = EXCLUDED.started_at,
      submitted_at = EXCLUDED.submitted_at,
      updated_at = NOW();

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Preflight status aktif peserta tanpa mengekspos kolom token ke role anon
CREATE OR REPLACE FUNCTION public.check_participant_active(
  p_participant_number TEXT
)
RETURNS TABLE (
  id TEXT,
  participant_number TEXT,
  full_name TEXT,
  class_name TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_rec public.participants%ROWTYPE;
BEGIN
  IF v_norm_num = '' THEN
    RETURN;
  END IF;

  SELECT * INTO v_rec
  FROM public.participants p
  WHERE p.participant_number = v_norm_num
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT * INTO v_rec
    FROM public.participants p
    WHERE UPPER(TRIM(p.participant_number)) = v_norm_num
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_rec.id,
    UPPER(TRIM(v_rec.participant_number)),
    v_rec.full_name,
    v_rec.class_name,
    v_rec.is_active,
    v_rec.created_at;
END;
$$;

-- RPC Staf Terverifikasi untuk manajemen participants & exam_schedules (menggantikan akses tulis terbuka role anon)
CREATE OR REPLACE FUNCTION public.staff_list_participants(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  participant_number TEXT,
  token TEXT,
  full_name TEXT,
  class_name TEXT,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, NULL);
  RETURN QUERY
    SELECT p.id, p.participant_number, p.token, p.full_name, p.class_name, p.is_active, p.created_at
    FROM public.participants p
    ORDER BY p.class_name ASC, p.participant_number ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_upsert_participants_batch(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_participants JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  item JSONB;
  v_count INTEGER := 0;
  v_norm_num TEXT;
  v_id TEXT;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'participants');

  IF p_participants IS NULL OR jsonb_typeof(p_participants) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_participants)
  LOOP
    IF item IS NULL OR jsonb_typeof(item) <> 'object' THEN
      CONTINUE;
    END IF;
    v_norm_num := UPPER(TRIM(COALESCE(item ->> 'participant_number', '')));
    IF v_norm_num = '' THEN
      CONTINUE;
    END IF;
    v_id := COALESCE(NULLIF(TRIM(COALESCE(item ->> 'id', '')), ''), gen_random_uuid()::text);

    INSERT INTO public.participants (
      id, participant_number, token, full_name, class_name, is_active, created_at
    )
    VALUES (
      v_id,
      v_norm_num,
      COALESCE(NULLIF(TRIM(COALESCE(item ->> 'token', '')), ''), 'CBT2026'),
      COALESCE(item ->> 'full_name', ''),
      COALESCE(item ->> 'class_name', ''),
      COALESCE(NULLIF(TRIM(COALESCE(item ->> 'is_active', '')), '')::BOOLEAN, TRUE),
      COALESCE(NULLIF(TRIM(COALESCE(item ->> 'created_at', '')), '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (participant_number) DO UPDATE SET
      token = EXCLUDED.token,
      full_name = EXCLUDED.full_name,
      class_name = EXCLUDED.class_name,
      is_active = EXCLUDED.is_active;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_delete_participants(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_ids TEXT[] DEFAULT NULL,
  p_delete_all BOOLEAN DEFAULT FALSE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'participants');

  IF COALESCE(p_delete_all, FALSE) THEN
    DELETE FROM public.participants;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
  END IF;

  IF p_ids IS NOT NULL AND array_length(p_ids, 1) IS NOT NULL THEN
    DELETE FROM public.participants WHERE id = ANY(p_ids);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_upsert_exam_schedules_batch(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_schedules JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  item JSONB;
  v_count INTEGER := 0;
  v_id TEXT;
  v_target_classes TEXT[];
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions');

  IF p_schedules IS NULL OR jsonb_typeof(p_schedules) <> 'array' THEN
    RETURN 0;
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_schedules)
  LOOP
    IF item IS NULL OR jsonb_typeof(item) <> 'object' THEN
      CONTINUE;
    END IF;
    v_id := NULLIF(TRIM(COALESCE(item ->> 'id', '')), '');
    IF v_id IS NULL THEN
      CONTINUE;
    END IF;

    v_target_classes := CASE
      WHEN jsonb_typeof(item -> 'target_classes') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(item -> 'target_classes'))
      ELSE '{}'::TEXT[]
    END;

    INSERT INTO public.exam_schedules (
      id, title, subject, kkm, duration_minutes, target_classes,
      is_active, randomize_questions, max_tab_switches, created_at
    )
    VALUES (
      v_id,
      COALESCE(item ->> 'title', ''),
      COALESCE(item ->> 'subject', ''),
      COALESCE(NULLIF(TRIM(COALESCE(item ->> 'kkm', '')), '')::INTEGER, 75),
      GREATEST(COALESCE(NULLIF(TRIM(COALESCE(item ->> 'duration_minutes', '')), '')::INTEGER, 60), 1),
      v_target_classes,
      COALESCE(NULLIF(TRIM(COALESCE(item ->> 'is_active', '')), '')::BOOLEAN, TRUE),
      COALESCE(NULLIF(TRIM(COALESCE(item ->> 'randomize_questions', '')), '')::BOOLEAN, FALSE),
      GREATEST(COALESCE(NULLIF(TRIM(COALESCE(item ->> 'max_tab_switches', '')), '')::INTEGER, 3), 1),
      COALESCE(NULLIF(TRIM(COALESCE(item ->> 'created_at', '')), '')::TIMESTAMPTZ, NOW())
    )
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      subject = EXCLUDED.subject,
      kkm = EXCLUDED.kkm,
      duration_minutes = EXCLUDED.duration_minutes,
      target_classes = EXCLUDED.target_classes,
      is_active = EXCLUDED.is_active,
      randomize_questions = EXCLUDED.randomize_questions,
      max_tab_switches = EXCLUDED.max_tab_switches;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_delete_exam_schedules(
  p_staff_user_id TEXT,
  p_staff_password_sha256 TEXT,
  p_ids TEXT[] DEFAULT NULL,
  p_delete_all BOOLEAN DEFAULT FALSE
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted INTEGER := 0;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions');

  IF COALESCE(p_delete_all, FALSE) THEN
    DELETE FROM public.exam_schedules;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
  END IF;

  IF p_ids IS NOT NULL AND array_length(p_ids, 1) IS NOT NULL THEN
    DELETE FROM public.exam_schedules WHERE id = ANY(p_ids);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  RETURN v_deleted;
END;
$$;

-- Cabut EXECUTE default dari PUBLIC lalu berikan hanya ke role yang semestinya
REVOKE ALL ON FUNCTION public.normalize_participant_number_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_verified_staff(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_server_time() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_student_questions(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_questions_sync_meta(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_question_coverage_summary(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_finish_exam_results(TEXT[], INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_participant_login(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_participant_active(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_staff_login(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_questions_batch(JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_question_by_id(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_accounts(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_account(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT[], BOOLEAN, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_account(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_school_profile(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_exam_results(TEXT, TEXT, TEXT[], TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_exam_results_batch(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_participants(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_participants_batch(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_participants(TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_exam_schedules_batch(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_exam_schedules(TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_student_questions(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_participant_login(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_participant_active(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_staff_login(TEXT, TEXT, TEXT) TO anon, authenticated, service_role;

-- RPC Admin/Staf di bawah ini tetap memvalidasi kredensial staf (staff_accounts/school_profile) atau service_role di dalam assert_verified_staff
GRANT EXECUTE ON FUNCTION public.get_questions_sync_meta(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_question_coverage_summary(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER, INTEGER, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.force_finish_exam_results(TEXT[], INTEGER, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_questions_batch(JSONB, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_question_by_id(TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_list_accounts(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upsert_account(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT[], BOOLEAN, BOOLEAN, TIMESTAMPTZ) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_delete_account(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upsert_school_profile(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_delete_exam_results(TEXT, TEXT, TEXT[], TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upsert_exam_results_batch(TEXT, TEXT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_list_participants(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upsert_participants_batch(TEXT, TEXT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_delete_participants(TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upsert_exam_schedules_batch(TEXT, TEXT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_delete_exam_schedules(TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated, service_role;

-- Bucket Supabase Storage untuk gambar soal (menggantikan Base64 di database) dengan batas MIME & ukuran ketat
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'question-images',
    'question-images',
    true,
    5242880,
    ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  )
  ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  DROP POLICY IF EXISTS "Public read question-images" ON storage.objects;
  CREATE POLICY "Public read question-images" ON storage.objects
    FOR SELECT TO anon, authenticated, service_role
    USING (bucket_id = 'question-images');

  DROP POLICY IF EXISTS "Allow upload question-images" ON storage.objects;
  CREATE POLICY "Allow upload question-images" ON storage.objects
    FOR INSERT TO anon, authenticated, service_role
    WITH CHECK (
      bucket_id = 'question-images'
      AND name ~ '^(q|opt|match-l|match-r)/[0-9]+-[a-z0-9]+\\.(png|jpg|jpeg|webp|gif)$'
    );

  DROP POLICY IF EXISTS "Allow update question-images" ON storage.objects;
  DROP POLICY IF EXISTS "Privileged update question-images" ON storage.objects;
  CREATE POLICY "Privileged update question-images" ON storage.objects
    FOR UPDATE TO authenticated, service_role
    USING (bucket_id = 'question-images')
    WITH CHECK (bucket_id = 'question-images');

  DROP POLICY IF EXISTS "Privileged delete question-images" ON storage.objects;
  CREATE POLICY "Privileged delete question-images" ON storage.objects
    FOR DELETE TO authenticated, service_role
    USING (bucket_id = 'question-images');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Nonaktifkan Realtime pada exam_results untuk mencegah badai WAL & broadcast CPU saat 800-1.000+ siswa
-- melakukan autosave/submit serentak (Dashboard Admin sudah memakai delta-sync ringan berbasis updated_at).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.exam_results;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.exam_schedules;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.participants;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.school_profile;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_accounts;
EXCEPTION WHEN duplicate_object OR undefined_object THEN NULL;
END $$;
`;

