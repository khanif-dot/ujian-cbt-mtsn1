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

-- participant_number sudah memiliki UNIQUE B-tree index bawaan; hapus indeks duplikat & fungsional agar hemat RAM & overhead write
DROP INDEX IF EXISTS public.idx_participants_number;
DROP INDEX IF EXISTS public.idx_participants_number_lower;
DROP INDEX IF EXISTS public.idx_participants_number_upper;
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
  answered_count INTEGER NOT NULL DEFAULT 0,
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
ALTER TABLE public.exam_results ADD COLUMN IF NOT EXISTS answered_count INTEGER NOT NULL DEFAULT 0;

-- Tuning HOT update & autovacuum agresif untuk 800-1.000+ siswa serentak
ALTER TABLE public.exam_results SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 100,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 50,
  autovacuum_vacuum_cost_limit = 1000
);

CREATE INDEX IF NOT EXISTS idx_questions_subject_lower ON public.questions(LOWER(TRIM(subject)));
CREATE INDEX IF NOT EXISTS idx_questions_target_classes_gin ON public.questions USING GIN (target_classes);
CREATE INDEX IF NOT EXISTS idx_questions_updated_at ON public.questions(updated_at DESC);

-- Hapus indeks tunggal & fungsional yang redundan untuk mengurangi overhead penulisan saat 800+ siswa autosave/submit
DROP INDEX IF EXISTS public.idx_exam_results_class;
DROP INDEX IF EXISTS public.idx_exam_results_subject;
DROP INDEX IF EXISTS public.idx_exam_results_status;
DROP INDEX IF EXISTS public.idx_exam_results_participant_lower_exam;
DROP INDEX IF EXISTS public.idx_exam_results_exam_status;
DROP INDEX IF EXISTS public.idx_exam_results_updated_at;

CREATE INDEX IF NOT EXISTS idx_exam_results_active_exam_started
  ON public.exam_results(exam_id, started_at ASC)
  WHERE status = 'in_progress' AND submitted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_exam_results_delta_cursor
  ON public.exam_results(updated_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_exam_schedules_active
  ON public.exam_schedules(id)
  WHERE is_active = TRUE;

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

-- Helper IMMUTABLE untuk menghitung jumlah jawaban terisi & penilaian soal menjodohkan
CREATE OR REPLACE FUNCTION public.count_answered_entries(p_answers JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_kv RECORD;
  v_txt TEXT;
  v_obj JSONB;
BEGIN
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' THEN
    RETURN 0;
  END IF;
  FOR v_kv IN SELECT key, value FROM jsonb_each(p_answers)
  LOOP
    IF v_kv.value IS NULL OR jsonb_typeof(v_kv.value) = 'null' THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_kv.value) = 'string' THEN
      v_txt := TRIM(v_kv.value #>> '{}');
      IF v_txt = '' THEN
        CONTINUE;
      END IF;
      IF LEFT(v_txt, 1) = '{' THEN
        BEGIN
          v_obj := v_txt::jsonb;
          IF jsonb_typeof(v_obj) = 'object' AND EXISTS (
            SELECT 1 FROM jsonb_each_text(v_obj) e WHERE NULLIF(TRIM(COALESCE(e.value, '')), '') IS NOT NULL
          ) THEN
            v_count := v_count + 1;
          END IF;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      ELSE
        v_count := v_count + 1;
      END IF;
    ELSIF jsonb_typeof(v_kv.value) = 'object' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_each_text(v_kv.value) e WHERE NULLIF(TRIM(COALESCE(e.value, '')), '') IS NOT NULL
      ) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.score_matching_answer(
  p_correct_answer TEXT,
  p_student_val JSONB,
  p_points NUMERIC
)
RETURNS TABLE (
  earned_points NUMERIC,
  is_full_match BOOLEAN
)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_correct_map JSONB;
  v_student_map JSONB := '{}'::jsonb;
  v_ans_text TEXT;
  v_pair_total INTEGER := 0;
  v_pair_matched INTEGER := 0;
  v_pts NUMERIC := COALESCE(p_points, 1);
BEGIN
  IF p_correct_answer IS NULL OR LEFT(TRIM(p_correct_answer), 1) <> '{' THEN
    RETURN QUERY SELECT 0::NUMERIC, FALSE;
    RETURN;
  END IF;
  v_correct_map := p_correct_answer::jsonb;
  IF jsonb_typeof(v_correct_map) <> 'object' THEN
    RETURN QUERY SELECT 0::NUMERIC, FALSE;
    RETURN;
  END IF;
  IF p_student_val IS NOT NULL THEN
    IF jsonb_typeof(p_student_val) = 'object' THEN
      v_student_map := p_student_val;
    ELSIF jsonb_typeof(p_student_val) = 'string' THEN
      v_ans_text := TRIM(p_student_val #>> '{}');
      IF LEFT(v_ans_text, 1) = '{' THEN
        v_student_map := v_ans_text::jsonb;
      END IF;
    END IF;
  END IF;
  SELECT
    COUNT(*)::INTEGER,
    COUNT(*) FILTER (WHERE (v_student_map ->> kv.key) = kv.value)::INTEGER
  INTO v_pair_total, v_pair_matched
  FROM jsonb_each_text(v_correct_map) AS kv;

  IF v_pair_total > 0 THEN
    RETURN QUERY SELECT (v_pts * v_pair_matched::NUMERIC / v_pair_total::NUMERIC), (v_pair_matched = v_pair_total);
  ELSE
    RETURN QUERY SELECT 0::NUMERIC, FALSE;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT 0::NUMERIC, FALSE;
END;
$$;

-- Trigger normalisasi participant_number konsisten (TRIM + UPPER) di tabel participants & exam_results (+ auto answered_count)
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

CREATE OR REPLACE FUNCTION public.normalize_exam_results_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.participant_number := UPPER(TRIM(COALESCE(NEW.participant_number, '')));
  IF TG_OP = 'INSERT' OR NEW.answers IS DISTINCT FROM OLD.answers OR NEW.answered_count IS NULL THEN
    NEW.answered_count := public.count_answered_entries(NEW.answers);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_base64_question_images_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.question_image_url IS DISTINCT FROM OLD.question_image_url)
     AND COALESCE(NEW.question_image_url, '') ~* '^\\s*data:image/' THEN
    RAISE EXCEPTION 'Inline Base64 image tidak diizinkan pada public.questions. Unggah gambar ke Storage bucket question-images.'
      USING ERRCODE = '22023';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.options IS DISTINCT FROM OLD.options)
     AND COALESCE(NEW.options::text, '') ~* 'data:image/' THEN
    RAISE EXCEPTION 'Inline Base64 image pada opsi soal tidak diizinkan. Unggah gambar ke Storage bucket question-images.'
      USING ERRCODE = '22023';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.matching_pairs IS DISTINCT FROM OLD.matching_pairs)
     AND COALESCE(NEW.matching_pairs::text, '') ~* 'data:image/' THEN
    RAISE EXCEPTION 'Inline Base64 image pada pasangan menjodohkan tidak diizinkan. Unggah gambar ke Storage bucket question-images.'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_normalize_participant_number_participants ON public.participants;
CREATE TRIGGER trg_normalize_participant_number_participants
  BEFORE INSERT OR UPDATE ON public.participants
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_participant_number_trigger();

DROP TRIGGER IF EXISTS trg_normalize_participant_number_results ON public.exam_results;
DROP TRIGGER IF EXISTS trg_normalize_exam_results ON public.exam_results;
CREATE TRIGGER trg_normalize_exam_results
  BEFORE INSERT OR UPDATE ON public.exam_results
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_exam_results_trigger();

DROP TRIGGER IF EXISTS trg_reject_base64_question_images ON public.questions;
CREATE TRIGGER trg_reject_base64_question_images
  BEFORE INSERT OR UPDATE ON public.questions
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_base64_question_images_trigger();

-- Backfill idempoten bila ada data lama berhuruf kecil/spasi atau answered_count belum terisi
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
  SET
    participant_number = UPPER(TRIM(participant_number)),
    answered_count = public.count_answered_entries(answers)
  WHERE participant_number <> UPPER(TRIM(participant_number))
     OR answered_count IS DISTINCT FROM public.count_answered_entries(answers);
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

-- exam_results: blokir total akses langsung role anon (seluruh pembacaan & penulisan wajib lewat RPC SECURITY DEFINER terverifikasi)
REVOKE ALL ON TABLE public.exam_results FROM PUBLIC, anon;
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
DROP POLICY IF EXISTS "Deny anon direct access exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Privileged read exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Privileged insert exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Privileged update exam_results" ON public.exam_results;
DROP POLICY IF EXISTS "Privileged delete exam_results" ON public.exam_results;
CREATE POLICY "Deny anon direct access exam_results" ON public.exam_results
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "Privileged read exam_results" ON public.exam_results
  FOR SELECT TO authenticated, service_role USING (true);
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
SET statement_timeout = '5s'
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
  v_req_tabs TEXT[];
BEGIN
  IF v_jwt_role IN ('service_role', 'supabase_admin')
     OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'supabase_admin')) THEN
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
    IF v_staff.role_type NOT IN ('admin', 'proktor', 'guru_mapel', 'custom') THEN
      RAISE EXCEPTION 'Invalid staff role_type' USING ERRCODE = '42501';
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
        IF ('sha256$' || encode(pg_catalog.sha256(convert_to(v_stored, 'UTF8')), 'hex')) = v_sha THEN
          v_matched := TRUE;
        END IF;
      END IF;

      IF v_matched THEN
        IF v_staff.role_type = 'admin' THEN
          RETURN;
        END IF;
        IF p_required_tab IS NULL OR TRIM(p_required_tab) = '' THEN
          IF array_length(v_staff.allowed_tabs, 1) IS NOT NULL AND array_length(v_staff.allowed_tabs, 1) > 0 THEN
            RETURN;
          END IF;
          RAISE EXCEPTION 'Forbidden staff tab privilege' USING ERRCODE = '42501';
        END IF;
        v_req_tabs := ARRAY(
          SELECT TRIM(t) FROM unnest(string_to_array(p_required_tab, ',')) AS t WHERE TRIM(t) <> ''
        );
        IF v_req_tabs && COALESCE(v_staff.allowed_tabs, '{}'::TEXT[]) THEN
          RETURN;
        END IF;
        RAISE EXCEPTION 'Forbidden staff tab privilege' USING ERRCODE = '42501';
      END IF;
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

CREATE OR REPLACE FUNCTION public.is_caller_admin_staff(
  p_staff_user_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role', ''),
    ''
  );
  v_norm_id TEXT := LOWER(TRIM(COALESCE(p_staff_user_id, '')));
  v_role TEXT;
BEGIN
  IF v_jwt_role IN ('service_role', 'supabase_admin')
     OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'supabase_admin')) THEN
    RETURN TRUE;
  END IF;
  IF v_norm_id = '' THEN
    RETURN FALSE;
  END IF;
  SELECT s.role_type INTO v_role
  FROM public.staff_accounts s
  WHERE LOWER(TRIM(s.user_id)) = v_norm_id AND s.is_active = TRUE
  ORDER BY s.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN v_role = 'admin';
  END IF;
  RETURN v_norm_id = 'admin';
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_verified_participant(
  p_participant_number TEXT,
  p_token TEXT DEFAULT NULL
)
RETURNS public.participants
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role', ''),
    ''
  );
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_norm_tok TEXT := UPPER(TRIM(COALESCE(p_token, '')));
  v_rec public.participants%ROWTYPE;
BEGIN
  IF v_norm_num <> '' THEN
    SELECT * INTO v_rec
    FROM public.participants p
    WHERE p.participant_number = v_norm_num
    LIMIT 1;
  END IF;

  IF v_jwt_role IN ('service_role', 'supabase_admin')
     OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'supabase_admin')) THEN
    RETURN v_rec;
  END IF;

  IF v_norm_num = '' OR v_norm_tok = '' THEN
    RAISE EXCEPTION 'Unauthorized participant credentials' USING ERRCODE = '42501';
  END IF;
  IF v_rec.id IS NULL THEN
    RAISE EXCEPTION 'Participant not found' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(v_rec.is_active, FALSE) THEN
    RAISE EXCEPTION 'Participant account is inactive' USING ERRCODE = '42501';
  END IF;
  IF UPPER(TRIM(COALESCE(v_rec.token, ''))) <> v_norm_tok THEN
    RAISE EXCEPTION 'Invalid participant token' USING ERRCODE = '42501';
  END IF;
  RETURN v_rec;
END;
$$;

DROP FUNCTION IF EXISTS public.get_student_questions(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_student_questions(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.get_student_questions(
  p_class_name TEXT,
  p_subject TEXT DEFAULT NULL,
  p_participant_number TEXT DEFAULT NULL,
  p_token TEXT DEFAULT NULL
)
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '15s'
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role', ''),
    ''
  );
  v_is_privileged BOOLEAN := v_jwt_role IN ('service_role', 'supabase_admin')
    OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'supabase_admin'));
  v_participant public.participants%ROWTYPE;
  v_effective_class TEXT := TRIM(COALESCE(p_class_name, ''));
BEGIN
  IF NOT v_is_privileged THEN
    v_participant := public.assert_verified_participant(p_participant_number, p_token);
    v_effective_class := v_participant.class_name;
    IF NOT EXISTS (
      SELECT 1 FROM public.exam_schedules s
      WHERE s.is_active = TRUE
        AND s.target_classes @> ARRAY[v_effective_class]
        AND (p_subject IS NULL OR TRIM(p_subject) = '' OR LOWER(TRIM(s.subject)) = LOWER(TRIM(p_subject)))
    ) THEN
      RAISE EXCEPTION 'No active exam schedule for participant class/subject' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT q.id, q.subject, q.target_classes, COALESCE(q.question_type, 'multiple_choice'), q.question_text, q.question_image_url, q.options, q.points, q.order_index
  FROM public.questions q
  WHERE q.target_classes @> ARRAY[v_effective_class]
    AND (p_subject IS NULL OR TRIM(p_subject) = '' OR LOWER(TRIM(q.subject)) = LOWER(TRIM(p_subject)))
  ORDER BY q.order_index ASC, q.id ASC;
END;
$$;

-- Guard Atomik Progres Ujian: Validasi Token + Server-Authoritative started_at + Lock Timeout
DROP FUNCTION IF EXISTS public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[]);
DROP FUNCTION IF EXISTS public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[], TEXT);

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
  p_question_ids TEXT[] DEFAULT NULL,
  p_token TEXT DEFAULT NULL
)
RETURNS TABLE (
  applied BOOLEAN,
  current_status TEXT,
  submitted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
SET lock_timeout = '2s'
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role', ''),
    ''
  );
  v_is_privileged BOOLEAN := v_jwt_role IN ('service_role', 'supabase_admin')
    OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'supabase_admin'));
  v_participant public.participants%ROWTYPE;
  v_sched public.exam_schedules%ROWTYPE;
  v_existing_status TEXT;
  v_existing_submitted TIMESTAMPTZ;
  v_actual_started_at TIMESTAMPTZ;
  v_norm_participant TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_effective_participant_id TEXT;
  v_effective_student_name TEXT;
  v_effective_class_name TEXT;
  v_effective_subject TEXT;
  v_effective_started_at TIMESTAMPTZ;
  v_effective_question_ids TEXT[] := CASE
    WHEN p_question_ids IS NOT NULL AND array_length(p_question_ids, 1) IS NOT NULL THEN p_question_ids
    ELSE NULL
  END;
BEGIN
  IF v_norm_participant = '' OR COALESCE(TRIM(p_exam_id), '') = '' THEN
    RETURN QUERY SELECT FALSE, 'invalid'::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_participant := public.assert_verified_participant(v_norm_participant, p_token);
  v_effective_participant_id := COALESCE(NULLIF(v_participant.id, ''), COALESCE(p_participant_id, ''));
  v_effective_student_name := COALESCE(NULLIF(v_participant.full_name, ''), COALESCE(p_student_name, ''));
  v_effective_class_name := COALESCE(NULLIF(v_participant.class_name, ''), COALESCE(p_class_name, ''));

  SELECT * INTO v_sched FROM public.exam_schedules s WHERE s.id = p_exam_id LIMIT 1;

  IF NOT v_is_privileged THEN
    IF NOT FOUND OR NOT COALESCE(v_sched.is_active, FALSE)
       OR NOT (v_sched.target_classes @> ARRAY[v_effective_class_name]) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.exam_results er
        WHERE er.participant_number = v_norm_participant AND er.exam_id = p_exam_id
      ) THEN
        RAISE EXCEPTION 'Exam schedule is inactive or unavailable for class' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  v_effective_subject := COALESCE(NULLIF(TRIM(v_sched.subject), ''), COALESCE(p_subject, ''));
  v_effective_started_at := CASE WHEN v_is_privileged THEN COALESCE(p_started_at, NOW()) ELSE NOW() END;

  INSERT INTO public.exam_results (
    id, participant_id, participant_number, student_name, class_name,
    exam_id, exam_title, subject, answers, flagged_questions, question_ids,
    correct_count, total_questions, score, tab_switch_count,
    status, started_at, submitted_at, updated_at
  )
  VALUES (
    p_result_id, v_effective_participant_id, v_norm_participant, v_effective_student_name, v_effective_class_name,
    p_exam_id, COALESCE(NULLIF(TRIM(v_sched.title), ''), COALESCE(p_exam_title, '')), v_effective_subject,
    COALESCE(p_answers, '{}'::jsonb),
    COALESCE(p_flagged_questions, '{}'::text[]), v_effective_question_ids,
    0, GREATEST(COALESCE(p_total_questions, 0), 0), 0, GREATEST(COALESCE(p_tab_switch_count, 0), 0),
    'in_progress', v_effective_started_at, NULL, NOW()
  )
  ON CONFLICT (participant_number, exam_id) DO UPDATE SET
    answers = EXCLUDED.answers,
    flagged_questions = EXCLUDED.flagged_questions,
    question_ids = COALESCE(public.exam_results.question_ids, EXCLUDED.question_ids),
    total_questions = GREATEST(EXCLUDED.total_questions, 0),
    tab_switch_count = GREATEST(public.exam_results.tab_switch_count, EXCLUDED.tab_switch_count),
    updated_at = NOW()
  WHERE public.exam_results.status = 'in_progress'
    AND public.exam_results.submitted_at IS NULL
  RETURNING public.exam_results.started_at INTO v_actual_started_at;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, 'in_progress'::TEXT, NULL::TIMESTAMPTZ, v_actual_started_at;
    RETURN;
  END IF;

  SELECT er.status, er.submitted_at, er.started_at
  INTO v_existing_status, v_existing_submitted, v_actual_started_at
  FROM public.exam_results er
  WHERE er.participant_number = v_norm_participant
    AND er.exam_id = p_exam_id
  LIMIT 1;

  RETURN QUERY SELECT FALSE, COALESCE(v_existing_status, 'submitted')::TEXT, v_existing_submitted, v_actual_started_at;
END;
$$;

-- Fungsi Penilaian Server-Side & Upsert Skor Akhir ke exam_results (Set-Based + Token Guard)
DROP FUNCTION IF EXISTS public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[]);
DROP FUNCTION IF EXISTS public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[], TEXT);

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
  p_question_ids TEXT[] DEFAULT NULL,
  p_token TEXT DEFAULT NULL
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
SET lock_timeout = '3s'
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role', ''),
    ''
  );
  v_is_privileged BOOLEAN := v_jwt_role IN ('service_role', 'supabase_admin')
    OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'supabase_admin'));
  v_participant public.participants%ROWTYPE;
  v_total_points NUMERIC := 0;
  v_earned_points NUMERIC := 0;
  v_correct INTEGER := 0;
  v_total_q INTEGER := 0;
  v_score NUMERIC(5,2) := 0;
  v_existing RECORD;
  v_sched_title TEXT;
  v_sched_subject TEXT;
  v_sched_max_tabs INTEGER;
  v_effective_subject TEXT;
  v_effective_max_tabs INTEGER;
  v_effective_tab_switches INTEGER;
  v_effective_question_ids TEXT[];
  v_effective_participant_id TEXT;
  v_effective_student_name TEXT;
  v_effective_class_name TEXT;
  v_effective_started_at TIMESTAMPTZ;
  v_target_status TEXT;
  v_norm_participant TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_has_q_ids BOOLEAN := FALSE;
  v_reconcile_auto_expired BOOLEAN := FALSE;
  v_effective_answers JSONB := COALESCE(p_answers, '{}'::jsonb);
  v_existing_ans_count INTEGER := 0;
  v_merged_ans_count INTEGER := 0;
BEGIN
  v_participant := public.assert_verified_participant(v_norm_participant, p_token);
  v_effective_participant_id := COALESCE(NULLIF(v_participant.id, ''), COALESCE(p_participant_id, ''));
  v_effective_student_name := COALESCE(NULLIF(v_participant.full_name, ''), COALESCE(p_student_name, ''));
  v_effective_class_name := COALESCE(NULLIF(v_participant.class_name, ''), COALESCE(p_class_name, ''));

  SELECT er.id, er.question_ids, er.answers, er.answered_count, er.correct_count, er.total_questions,
         er.score, er.status, er.started_at, er.submitted_at, er.tab_switch_count, er.finalized_by
  INTO v_existing
  FROM public.exam_results er
  WHERE er.participant_number = v_norm_participant
    AND er.exam_id = p_exam_id
  LIMIT 1;

  IF FOUND AND (v_existing.status <> 'in_progress' OR v_existing.submitted_at IS NOT NULL) THEN
    IF (
      (v_existing.finalized_by = 'auto_expired'
        AND (v_existing.submitted_at IS NULL OR NOW() - v_existing.submitted_at <= INTERVAL '24 hours'))
      OR
      (v_existing.finalized_by = 'staff_force'
        AND (v_existing.submitted_at IS NULL OR NOW() - v_existing.submitted_at <= INTERVAL '3 minutes'))
    ) THEN
      v_effective_answers := COALESCE(v_existing.answers, '{}'::jsonb) || COALESCE(p_answers, '{}'::jsonb);
      v_existing_ans_count := COALESCE(v_existing.answered_count, public.count_answered_entries(v_existing.answers));
      v_merged_ans_count := public.count_answered_entries(v_effective_answers);
      IF v_merged_ans_count > v_existing_ans_count THEN
        v_reconcile_auto_expired := TRUE;
      END IF;
    END IF;

    IF NOT v_reconcile_auto_expired THEN
      RETURN QUERY SELECT v_existing.correct_count, v_existing.total_questions, v_existing.score;
      RETURN;
    END IF;
  END IF;

  SELECT s.title, s.subject, s.max_tab_switches
  INTO v_sched_title, v_sched_subject, v_sched_max_tabs
  FROM public.exam_schedules s
  WHERE s.id = p_exam_id
  LIMIT 1;

  IF NOT FOUND AND p_subject IS NOT NULL AND TRIM(p_subject) <> '' THEN
    SELECT s.title, s.subject, s.max_tab_switches
    INTO v_sched_title, v_sched_subject, v_sched_max_tabs
    FROM public.exam_schedules s
    WHERE LOWER(TRIM(s.subject)) = LOWER(TRIM(p_subject))
    LIMIT 1;
  END IF;

  v_effective_subject := COALESCE(NULLIF(TRIM(v_sched_subject), ''), NULLIF(TRIM(p_subject), ''), '');
  v_effective_max_tabs := COALESCE(v_sched_max_tabs, p_max_tab_switches, 3);
  v_effective_question_ids := COALESCE(NULLIF(v_existing.question_ids, '{}'), NULLIF(p_question_ids, '{}'));
  v_has_q_ids := v_effective_question_ids IS NOT NULL AND array_length(v_effective_question_ids, 1) IS NOT NULL;
  v_effective_tab_switches := GREATEST(COALESCE(v_existing.tab_switch_count, 0), GREATEST(COALESCE(p_tab_switch_count, 0), 0));
  v_effective_started_at := COALESCE(
    v_existing.started_at,
    CASE WHEN v_is_privileged THEN COALESCE(p_started_at, NOW()) ELSE NOW() END
  );

  IF v_has_q_ids THEN
    SELECT
      COUNT(*)::INTEGER,
      COALESCE(SUM(COALESCE(q.points, 1)), 0)::NUMERIC,
      COUNT(*) FILTER (
        WHERE CASE
          WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
            THEN m.is_full_match
          ELSE (v_effective_answers ->> q.id) = q.correct_answer
        END
      )::INTEGER,
      COALESCE(SUM(
        CASE
          WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
            THEN m.earned_points
          WHEN (v_effective_answers ->> q.id) = q.correct_answer
            THEN COALESCE(q.points, 1)::NUMERIC
          ELSE 0::NUMERIC
        END
      ), 0)::NUMERIC
    INTO v_total_q, v_total_points, v_correct, v_earned_points
    FROM public.questions q
    LEFT JOIN LATERAL public.score_matching_answer(
      q.correct_answer,
      v_effective_answers -> q.id,
      COALESCE(q.points, 1)::NUMERIC
    ) m ON (COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{')
    WHERE q.id = ANY(v_effective_question_ids)
      AND q.target_classes @> ARRAY[v_effective_class_name]
      AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject));
  END IF;

  IF v_total_q = 0 THEN
    SELECT
      COUNT(*)::INTEGER,
      COALESCE(SUM(COALESCE(q.points, 1)), 0)::NUMERIC,
      COUNT(*) FILTER (
        WHERE CASE
          WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
            THEN m.is_full_match
          ELSE (v_effective_answers ->> q.id) = q.correct_answer
        END
      )::INTEGER,
      COALESCE(SUM(
        CASE
          WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
            THEN m.earned_points
          WHEN (v_effective_answers ->> q.id) = q.correct_answer
            THEN COALESCE(q.points, 1)::NUMERIC
          ELSE 0::NUMERIC
        END
      ), 0)::NUMERIC
    INTO v_total_q, v_total_points, v_correct, v_earned_points
    FROM public.questions q
    LEFT JOIN LATERAL public.score_matching_answer(
      q.correct_answer,
      v_effective_answers -> q.id,
      COALESCE(q.points, 1)::NUMERIC
    ) m ON (COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{')
    WHERE q.target_classes @> ARRAY[v_effective_class_name]
      AND (v_effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(v_effective_subject));
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
      AND finalized_by IN ('auto_expired', 'staff_force');

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

  INSERT INTO public.exam_results (
    id, participant_id, participant_number, student_name, class_name,
    exam_id, exam_title, subject, answers, flagged_questions, question_ids,
    correct_count, total_questions, score, tab_switch_count,
    status, started_at, submitted_at, finalized_by, updated_at
  )
  VALUES (
    COALESCE(v_existing.id, p_result_id), v_effective_participant_id, v_norm_participant,
    v_effective_student_name, v_effective_class_name,
    p_exam_id, COALESCE(NULLIF(TRIM(v_sched_title), ''), COALESCE(p_exam_title, '')),
    COALESCE(NULLIF(TRIM(v_effective_subject), ''), COALESCE(p_subject, '')),
    v_effective_answers, COALESCE(p_flagged_questions, '{}'::text[]), v_effective_question_ids,
    v_correct, v_total_q, v_score, v_effective_tab_switches,
    v_target_status, v_effective_started_at, NOW(), 'student', NOW()
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
SET search_path = public, extensions
AS $$
DECLARE
  item JSONB;
  v_id TEXT;
  v_target_classes TEXT[];
  v_points INTEGER;
  v_order_idx INTEGER;
  v_question_text TEXT;
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

    v_question_text := replace(replace(COALESCE(item ->> 'question_text', ''), E'\\r\\n', E'\\n'), E'\\r', E'\\n');

    INSERT INTO public.questions (
      id, subject, target_classes, question_type, question_text, question_image_url,
      options, matching_pairs, correct_answer, points, order_index, updated_at
    )
    VALUES (
      v_id,
      COALESCE(item ->> 'subject', ''),
      v_target_classes,
      COALESCE(NULLIF(item ->> 'question_type', ''), 'multiple_choice'),
      v_question_text,
      TRIM(COALESCE(item ->> 'question_image_url', '')),
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
SET statement_timeout = '10s'
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions,dashboard,database');
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
SET statement_timeout = '15s'
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
SET statement_timeout = '10s'
SET lock_timeout = '3s'
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions');
  DELETE FROM public.questions WHERE id = p_id;
END;
$$;

-- Penilaian otomatis batch di server berbasis set CTE (tanpa RBAR loop, FOR UPDATE SKIP LOCKED)
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
SET statement_timeout = '20s'
SET lock_timeout = '3s'
AS $$
DECLARE
  v_sched_subject TEXT;
  v_sched_max_tabs INTEGER;
  v_effective_max_tabs INTEGER;
  v_effective_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_finalized_count INTEGER := 0;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,reset,recap');

  SELECT s.subject, s.max_tab_switches
  INTO v_sched_subject, v_sched_max_tabs
  FROM public.exam_schedules s
  WHERE s.id = p_exam_id
  LIMIT 1;

  v_effective_max_tabs := COALESCE(v_sched_max_tabs, p_max_tab_switches, 3);

  WITH locked_rows AS (
    SELECT er.id, er.class_name, er.subject, er.answers, er.question_ids, er.tab_switch_count
    FROM public.exam_results er
    WHERE er.exam_id = p_exam_id
      AND er.status = 'in_progress'
      AND er.submitted_at IS NULL
      AND er.started_at <= p_cutoff
    ORDER BY er.started_at ASC
    LIMIT v_effective_limit
    FOR UPDATE SKIP LOCKED
  ),
  enriched AS (
    SELECT
      lr.*,
      COALESCE(NULLIF(TRIM(v_sched_subject), ''), NULLIF(TRIM(lr.subject), ''), '') AS effective_subject,
      (lr.question_ids IS NOT NULL AND array_length(lr.question_ids, 1) IS NOT NULL) AS has_q_ids
    FROM locked_rows lr
  ),
  scored_by_ids AS (
    SELECT
      e.id AS result_id,
      e.tab_switch_count,
      e.class_name,
      e.effective_subject,
      e.answers,
      COALESCE(agg.total_q, 0) AS total_q,
      COALESCE(agg.total_points, 0) AS total_points,
      COALESCE(agg.correct_count, 0) AS correct_count,
      COALESCE(agg.earned_points, 0) AS earned_points
    FROM enriched e
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::INTEGER AS total_q,
        COALESCE(SUM(COALESCE(q.points, 1)), 0)::NUMERIC AS total_points,
        COUNT(*) FILTER (
          WHERE CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.is_full_match
            ELSE (e.answers ->> q.id) = q.correct_answer
          END
        )::INTEGER AS correct_count,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.earned_points
            WHEN (e.answers ->> q.id) = q.correct_answer
              THEN COALESCE(q.points, 1)::NUMERIC
            ELSE 0::NUMERIC
          END
        ), 0)::NUMERIC AS earned_points
      FROM public.questions q
      LEFT JOIN LATERAL public.score_matching_answer(
        q.correct_answer,
        e.answers -> q.id,
        COALESCE(q.points, 1)::NUMERIC
      ) m ON (COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{')
      WHERE e.has_q_ids
        AND q.id = ANY(e.question_ids)
        AND q.target_classes @> ARRAY[e.class_name]
        AND (e.effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(e.effective_subject))
    ) agg ON TRUE
  ),
  final_scores AS (
    SELECT
      s.result_id,
      s.tab_switch_count,
      CASE WHEN s.total_q > 0 THEN s.total_q ELSE COALESCE(fb.total_q, 0) END AS total_q,
      CASE WHEN s.total_q > 0 THEN s.total_points ELSE COALESCE(fb.total_points, 0) END AS total_points,
      CASE WHEN s.total_q > 0 THEN s.correct_count ELSE COALESCE(fb.correct_count, 0) END AS correct_count,
      CASE WHEN s.total_q > 0 THEN s.earned_points ELSE COALESCE(fb.earned_points, 0) END AS earned_points
    FROM scored_by_ids s
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::INTEGER AS total_q,
        COALESCE(SUM(COALESCE(q.points, 1)), 0)::NUMERIC AS total_points,
        COUNT(*) FILTER (
          WHERE CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.is_full_match
            ELSE (s.answers ->> q.id) = q.correct_answer
          END
        )::INTEGER AS correct_count,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.earned_points
            WHEN (s.answers ->> q.id) = q.correct_answer
              THEN COALESCE(q.points, 1)::NUMERIC
            ELSE 0::NUMERIC
          END
        ), 0)::NUMERIC AS earned_points
      FROM public.questions q
      LEFT JOIN LATERAL public.score_matching_answer(
        q.correct_answer,
        s.answers -> q.id,
        COALESCE(q.points, 1)::NUMERIC
      ) m ON (COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{')
      WHERE s.total_q = 0
        AND q.target_classes @> ARRAY[s.class_name]
        AND (s.effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(s.effective_subject))
    ) fb ON TRUE
  ),
  updated AS (
    UPDATE public.exam_results er
    SET
      correct_count = fs.correct_count,
      total_questions = fs.total_q,
      score = CASE WHEN fs.total_points > 0 THEN ROUND((fs.earned_points / fs.total_points) * 100, 2) ELSE 0 END,
      status = CASE WHEN fs.tab_switch_count >= v_effective_max_tabs THEN 'flagged' ELSE 'submitted' END,
      submitted_at = NOW(),
      finalized_by = 'auto_expired',
      updated_at = NOW()
    FROM final_scores fs
    WHERE er.id = fs.result_id
      AND fs.total_q > 0
      AND er.status = 'in_progress'
      AND er.submitted_at IS NULL
    RETURNING er.id
  )
  SELECT COUNT(*)::INTEGER INTO v_finalized_count FROM updated;

  RETURN v_finalized_count;
END;
$$;

-- Paksa-selesai & penilaian batch di server berbasis set CTE (tanpa RBAR loop)
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
SET statement_timeout = '20s'
SET lock_timeout = '3s'
AS $$
DECLARE
  v_effective_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_finished_count INTEGER := 0;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,reset');

  IF p_result_ids IS NULL OR array_length(p_result_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH locked_rows AS (
    SELECT er.id, er.exam_id, er.class_name, er.subject, er.answers, er.question_ids, er.tab_switch_count
    FROM public.exam_results er
    WHERE er.id = ANY(p_result_ids)
      AND er.status = 'in_progress'
      AND er.submitted_at IS NULL
    ORDER BY er.started_at ASC
    LIMIT v_effective_limit
    FOR UPDATE SKIP LOCKED
  ),
  enriched AS (
    SELECT
      lr.*,
      COALESCE(NULLIF(TRIM(sched.subject), ''), NULLIF(TRIM(lr.subject), ''), '') AS effective_subject,
      COALESCE(sched.max_tab_switches, 3) AS effective_max_tabs,
      (lr.question_ids IS NOT NULL AND array_length(lr.question_ids, 1) IS NOT NULL) AS has_q_ids
    FROM locked_rows lr
    LEFT JOIN LATERAL (
      SELECT s.subject, s.max_tab_switches
      FROM public.exam_schedules s
      WHERE s.id = lr.exam_id
         OR (NULLIF(TRIM(lr.subject), '') IS NOT NULL AND LOWER(TRIM(s.subject)) = LOWER(TRIM(lr.subject)))
      ORDER BY CASE WHEN s.id = lr.exam_id THEN 0 ELSE 1 END
      LIMIT 1
    ) sched ON TRUE
  ),
  scored_by_ids AS (
    SELECT
      e.id AS result_id,
      e.tab_switch_count,
      e.effective_max_tabs,
      e.class_name,
      e.effective_subject,
      e.answers,
      COALESCE(agg.total_q, 0) AS total_q,
      COALESCE(agg.total_points, 0) AS total_points,
      COALESCE(agg.correct_count, 0) AS correct_count,
      COALESCE(agg.earned_points, 0) AS earned_points
    FROM enriched e
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::INTEGER AS total_q,
        COALESCE(SUM(COALESCE(q.points, 1)), 0)::NUMERIC AS total_points,
        COUNT(*) FILTER (
          WHERE CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.is_full_match
            ELSE (e.answers ->> q.id) = q.correct_answer
          END
        )::INTEGER AS correct_count,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.earned_points
            WHEN (e.answers ->> q.id) = q.correct_answer
              THEN COALESCE(q.points, 1)::NUMERIC
            ELSE 0::NUMERIC
          END
        ), 0)::NUMERIC AS earned_points
      FROM public.questions q
      LEFT JOIN LATERAL public.score_matching_answer(
        q.correct_answer,
        e.answers -> q.id,
        COALESCE(q.points, 1)::NUMERIC
      ) m ON (COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{')
      WHERE e.has_q_ids
        AND q.id = ANY(e.question_ids)
        AND q.target_classes @> ARRAY[e.class_name]
        AND (e.effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(e.effective_subject))
    ) agg ON TRUE
  ),
  final_scores AS (
    SELECT
      s.result_id,
      s.tab_switch_count,
      s.effective_max_tabs,
      CASE WHEN s.total_q > 0 THEN s.total_q ELSE COALESCE(fb.total_q, 0) END AS total_q,
      CASE WHEN s.total_q > 0 THEN s.total_points ELSE COALESCE(fb.total_points, 0) END AS total_points,
      CASE WHEN s.total_q > 0 THEN s.correct_count ELSE COALESCE(fb.correct_count, 0) END AS correct_count,
      CASE WHEN s.total_q > 0 THEN s.earned_points ELSE COALESCE(fb.earned_points, 0) END AS earned_points
    FROM scored_by_ids s
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)::INTEGER AS total_q,
        COALESCE(SUM(COALESCE(q.points, 1)), 0)::NUMERIC AS total_points,
        COUNT(*) FILTER (
          WHERE CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.is_full_match
            ELSE (s.answers ->> q.id) = q.correct_answer
          END
        )::INTEGER AS correct_count,
        COALESCE(SUM(
          CASE
            WHEN COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{'
              THEN m.earned_points
            WHEN (s.answers ->> q.id) = q.correct_answer
              THEN COALESCE(q.points, 1)::NUMERIC
            ELSE 0::NUMERIC
          END
        ), 0)::NUMERIC AS earned_points
      FROM public.questions q
      LEFT JOIN LATERAL public.score_matching_answer(
        q.correct_answer,
        s.answers -> q.id,
        COALESCE(q.points, 1)::NUMERIC
      ) m ON (COALESCE(q.question_type, 'multiple_choice') = 'matching' OR LEFT(TRIM(q.correct_answer), 1) = '{')
      WHERE s.total_q = 0
        AND q.target_classes @> ARRAY[s.class_name]
        AND (s.effective_subject = '' OR LOWER(TRIM(q.subject)) = LOWER(s.effective_subject))
    ) fb ON TRUE
  ),
  updated AS (
    UPDATE public.exam_results er
    SET
      correct_count = fs.correct_count,
      total_questions = fs.total_q,
      score = CASE WHEN fs.total_points > 0 THEN ROUND((fs.earned_points / fs.total_points) * 100, 2) ELSE 0 END,
      status = CASE WHEN fs.tab_switch_count >= fs.effective_max_tabs THEN 'flagged' ELSE 'submitted' END,
      submitted_at = NOW(),
      finalized_by = 'staff_force',
      updated_at = NOW()
    FROM final_scores fs
    WHERE er.id = fs.result_id
      AND fs.total_q > 0
      AND er.status = 'in_progress'
      AND er.submitted_at IS NULL
    RETURNING er.id
  )
  SELECT COUNT(*)::INTEGER INTO v_finished_count FROM updated;

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

  SELECT * INTO v_rec
  FROM public.participants p
  WHERE p.participant_number = v_norm_num
  LIMIT 1;

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
    'ok'::TEXT, v_rec.id, v_rec.participant_number, v_rec.token,
    v_rec.full_name, v_rec.class_name, v_rec.is_active, v_rec.created_at;
END;
$$;

-- Bootstrap Ringkas Halaman Login Siswa (1 roundtrip = server_time + profil tanpa logo kemenag + jadwal aktif saja)
CREATE OR REPLACE FUNCTION public.get_student_bootstrap(
  p_known_profile_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  server_time TIMESTAMPTZ,
  profile_changed BOOLEAN,
  profile JSONB,
  active_schedules JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  v_prof RECORD;
  v_profile_changed BOOLEAN := FALSE;
  v_profile_json JSONB := NULL;
  v_schedules_json JSONB := '[]'::jsonb;
BEGIN
  SELECT
    sp.id,
    sp.school_name,
    sp.address,
    sp.academic_year,
    sp.principal_name,
    sp.committee_chair_name,
    sp.exam_title,
    sp.logo_data_url,
    sp.updated_at
  INTO v_prof
  FROM public.school_profile sp
  WHERE sp.id = 'default'
  LIMIT 1;

  IF FOUND THEN
    IF p_known_profile_updated_at IS NULL
       OR ABS(EXTRACT(EPOCH FROM (v_prof.updated_at - p_known_profile_updated_at))) >= 1 THEN
      v_profile_changed := TRUE;
      v_profile_json := jsonb_build_object(
        'id', v_prof.id,
        'school_name', v_prof.school_name,
        'address', v_prof.address,
        'academic_year', v_prof.academic_year,
        'principal_name', v_prof.principal_name,
        'committee_chair_name', v_prof.committee_chair_name,
        'exam_title', v_prof.exam_title,
        'logo_data_url', COALESCE(v_prof.logo_data_url, ''),
        'updated_at', v_prof.updated_at
      );
    ELSE
      v_profile_changed := FALSE;
      v_profile_json := jsonb_build_object(
        'id', v_prof.id,
        'updated_at', v_prof.updated_at
      );
    END IF;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'title', s.title,
        'subject', s.subject,
        'kkm', s.kkm,
        'duration_minutes', s.duration_minutes,
        'target_classes', s.target_classes,
        'is_active', s.is_active,
        'randomize_questions', s.randomize_questions,
        'max_tab_switches', s.max_tab_switches,
        'created_at', s.created_at
      )
      ORDER BY s.id ASC
    ),
    '[]'::jsonb
  )
  INTO v_schedules_json
  FROM public.exam_schedules s
  WHERE s.is_active = TRUE;

  RETURN QUERY SELECT NOW(), v_profile_changed, v_profile_json, v_schedules_json;
END;
$$;

-- RPC Gabungan Login Siswa (1 roundtrip = verifikasi peserta & token + waktu server + status hasil ujian milik peserta)
-- Untuk baris submitted/flagged hanya mengirim metadata ringkas (hemat bandwidth); untuk in_progress menyertakan answers/question_ids agar langsung bisa lanjut tanpa query ulang.
CREATE OR REPLACE FUNCTION public.student_login_bundle(
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
  created_at TIMESTAMPTZ,
  server_time TIMESTAMPTZ,
  results JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_norm_tok TEXT := UPPER(TRIM(COALESCE(p_token, '')));
  v_rec public.participants%ROWTYPE;
  v_results_json JSONB := '[]'::jsonb;
BEGIN
  IF v_norm_num = '' THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ, NOW(), '[]'::jsonb;
    RETURN;
  END IF;

  SELECT * INTO v_rec
  FROM public.participants p
  WHERE p.participant_number = v_norm_num
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ, NOW(), '[]'::jsonb;
    RETURN;
  END IF;

  IF NOT COALESCE(v_rec.is_active, FALSE) THEN
    RETURN QUERY SELECT 'inactive'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, FALSE::BOOLEAN, NULL::TIMESTAMPTZ, NOW(), '[]'::jsonb;
    RETURN;
  END IF;

  IF UPPER(TRIM(COALESCE(v_rec.token, ''))) <> v_norm_tok THEN
    RETURN QUERY SELECT 'wrong_token'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::BOOLEAN, NULL::TIMESTAMPTZ, NOW(), '[]'::jsonb;
    RETURN;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', er.id,
        'participant_id', er.participant_id,
        'participant_number', er.participant_number,
        'student_name', er.student_name,
        'class_name', er.class_name,
        'exam_id', er.exam_id,
        'exam_title', er.exam_title,
        'subject', er.subject,
        'answers', CASE WHEN er.status = 'in_progress' THEN er.answers ELSE '{}'::jsonb END,
        'flagged_questions', CASE WHEN er.status = 'in_progress' THEN er.flagged_questions ELSE '{}'::text[] END,
        'question_ids', CASE WHEN er.status = 'in_progress' THEN er.question_ids ELSE NULL END,
        'answered_count', er.answered_count,
        'correct_count', er.correct_count,
        'total_questions', er.total_questions,
        'score', er.score,
        'tab_switch_count', er.tab_switch_count,
        'status', er.status,
        'started_at', er.started_at,
        'submitted_at', er.submitted_at,
        'updated_at', er.updated_at
      )
    ),
    '[]'::jsonb
  )
  INTO v_results_json
  FROM public.exam_results er
  WHERE er.participant_number = v_rec.participant_number;

  RETURN QUERY SELECT
    'ok'::TEXT,
    v_rec.id,
    v_rec.participant_number,
    v_rec.token,
    v_rec.full_name,
    v_rec.class_name,
    v_rec.is_active,
    v_rec.created_at,
    NOW(),
    v_results_json;
END;
$$;

-- RPC Pengganti SELECT anon langsung untuk mengambil hasil & cek status ujian milik peserta terverifikasi
DROP FUNCTION IF EXISTS public.student_get_my_results(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.student_get_my_results(
  p_participant_number TEXT,
  p_token TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  participant_id TEXT,
  participant_number TEXT,
  student_name TEXT,
  class_name TEXT,
  exam_id TEXT,
  exam_title TEXT,
  subject TEXT,
  answers JSONB,
  flagged_questions TEXT[],
  question_ids TEXT[],
  answered_count INTEGER,
  correct_count INTEGER,
  total_questions INTEGER,
  score NUMERIC(5,2),
  tab_switch_count INTEGER,
  status TEXT,
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $$
DECLARE
  v_participant public.participants%ROWTYPE;
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
BEGIN
  v_participant := public.assert_verified_participant(v_norm_num, p_token);
  RETURN QUERY
  SELECT
    er.id, er.participant_id, er.participant_number, er.student_name, er.class_name,
    er.exam_id, er.exam_title, er.subject,
    CASE WHEN er.status = 'in_progress' THEN er.answers ELSE '{}'::jsonb END,
    CASE WHEN er.status = 'in_progress' THEN er.flagged_questions ELSE '{}'::text[] END,
    CASE WHEN er.status = 'in_progress' THEN er.question_ids ELSE NULL END,
    er.answered_count, er.correct_count, er.total_questions, er.score,
    er.tab_switch_count, er.status, er.started_at, er.submitted_at, er.updated_at
  FROM public.exam_results er
  WHERE er.participant_number = COALESCE(NULLIF(v_participant.participant_number, ''), v_norm_num);
END;
$$;

DROP FUNCTION IF EXISTS public.student_check_exam_status(TEXT, TEXT, TEXT, BOOLEAN);
CREATE OR REPLACE FUNCTION public.student_check_exam_status(
  p_participant_number TEXT,
  p_exam_id TEXT,
  p_token TEXT DEFAULT NULL,
  p_include_full BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id TEXT,
  participant_id TEXT,
  participant_number TEXT,
  student_name TEXT,
  class_name TEXT,
  exam_id TEXT,
  exam_title TEXT,
  subject TEXT,
  answers JSONB,
  flagged_questions TEXT[],
  question_ids TEXT[],
  answered_count INTEGER,
  correct_count INTEGER,
  total_questions INTEGER,
  score NUMERIC(5,2),
  tab_switch_count INTEGER,
  status TEXT,
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '8s'
AS $$
DECLARE
  v_participant public.participants%ROWTYPE;
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
BEGIN
  v_participant := public.assert_verified_participant(v_norm_num, p_token);
  RETURN QUERY
  SELECT
    er.id, er.participant_id, er.participant_number, er.student_name, er.class_name,
    er.exam_id, er.exam_title, er.subject,
    CASE WHEN COALESCE(p_include_full, FALSE) THEN er.answers ELSE '{}'::jsonb END,
    CASE WHEN COALESCE(p_include_full, FALSE) THEN er.flagged_questions ELSE '{}'::text[] END,
    CASE WHEN COALESCE(p_include_full, FALSE) THEN er.question_ids ELSE NULL END,
    er.answered_count, er.correct_count, er.total_questions, er.score,
    er.tab_switch_count, er.status, er.started_at, er.submitted_at, er.updated_at
  FROM public.exam_results er
  WHERE er.participant_number = COALESCE(NULLIF(v_participant.participant_number, ''), v_norm_num)
    AND er.exam_id = p_exam_id
  LIMIT 1;
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
SET statement_timeout = '10s'
SET lock_timeout = '3s'
AS $$
DECLARE
  v_clean_uid TEXT := TRIM(COALESCE(p_target_user_id, ''));
  v_clean_pwd TEXT := NULLIF(TRIM(COALESCE(p_password_hash, '')), '');
  v_target_role TEXT := COALESCE(NULLIF(TRIM(COALESCE(p_role_type, '')), ''), 'guru_mapel');
  v_existing public.staff_accounts%ROWTYPE;
  v_caller_is_admin BOOLEAN;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'roles');

  IF v_clean_uid = '' THEN
    RAISE EXCEPTION 'Target user_id is required';
  END IF;

  IF v_target_role NOT IN ('admin', 'proktor', 'guru_mapel', 'custom') THEN
    RAISE EXCEPTION 'Invalid role_type value' USING ERRCODE = '22023';
  END IF;

  IF v_clean_pwd = '__CLOUD_MANAGED__' THEN
    v_clean_pwd := NULL;
  END IF;

  SELECT * INTO v_existing
  FROM public.staff_accounts s
  WHERE s.id = p_id OR LOWER(TRIM(s.user_id)) = LOWER(v_clean_uid)
  ORDER BY CASE WHEN s.id = p_id THEN 0 ELSE 1 END
  LIMIT 1;

  v_caller_is_admin := public.is_caller_admin_staff(p_staff_user_id);
  IF NOT v_caller_is_admin AND (
    v_target_role = 'admin'
    OR LOWER(v_clean_uid) = 'admin'
    OR (v_existing.id IS NOT NULL AND (v_existing.role_type = 'admin' OR LOWER(TRIM(v_existing.user_id)) = 'admin'))
  ) THEN
    RAISE EXCEPTION 'Only administrator accounts can manage admin role_type' USING ERRCODE = '42501';
  END IF;

  IF FOUND THEN
    DELETE FROM public.staff_accounts
    WHERE LOWER(TRIM(user_id)) = LOWER(v_clean_uid)
      AND id <> v_existing.id;

    UPDATE public.staff_accounts SET
      user_id = v_clean_uid,
      name = TRIM(COALESCE(p_name, '')),
      password_hash = COALESCE(v_clean_pwd, public.staff_accounts.password_hash),
      role_type = v_target_role,
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
      v_target_role, COALESCE(p_role_label, 'Staff'),
      COALESCE(p_allowed_tabs, '{}'::TEXT[]), COALESCE(p_assigned_subjects, '{}'::TEXT[]),
      COALESCE(p_restrict_to_assigned_subjects, FALSE), COALESCE(p_is_active, TRUE),
      COALESCE(p_created_at, NOW())
    );
  END IF;

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
SET statement_timeout = '10s'
SET lock_timeout = '3s'
AS $$
DECLARE
  v_caller_is_admin BOOLEAN;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'roles');
  IF LOWER(TRIM(COALESCE(p_target_user_id, ''))) = 'admin' THEN
    RETURN;
  END IF;
  v_caller_is_admin := public.is_caller_admin_staff(p_staff_user_id);
  IF NOT v_caller_is_admin AND EXISTS (
    SELECT 1 FROM public.staff_accounts s
    WHERE (s.id = p_target_id OR (p_target_user_id IS NOT NULL AND LOWER(TRIM(s.user_id)) = LOWER(TRIM(p_target_user_id))))
      AND s.role_type = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only administrator accounts can delete admin accounts' USING ERRCODE = '42501';
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
SET statement_timeout = '15s'
SET lock_timeout = '3s'
AS $$
DECLARE
  v_deleted INTEGER := 0;
  v_rows INTEGER := 0;
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,reset,database');

  IF p_result_ids IS NOT NULL AND array_length(p_result_ids, 1) IS NOT NULL THEN
    DELETE FROM public.exam_results WHERE id = ANY(p_result_ids);
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_deleted := v_deleted + v_rows;
  END IF;

  IF v_norm_num <> '' AND COALESCE(TRIM(p_exam_id), '') <> '' THEN
    DELETE FROM public.exam_results
    WHERE participant_number = v_norm_num
      AND exam_id = p_exam_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_deleted := v_deleted + v_rows;
  END IF;

  RETURN v_deleted;
END;
$$;

-- RPC Delta-Sync Ringkas & Rekonsiliasi Admin (HEMAT EGRESS 80-95%: tanpa answers JSONB)
DROP FUNCTION IF EXISTS public.staff_list_exam_results_summary(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, TEXT);
CREATE OR REPLACE FUNCTION public.staff_list_exam_results_summary(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL,
  p_updated_after TIMESTAMPTZ DEFAULT NULL,
  p_after_id TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 1000,
  p_exam_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id TEXT,
  participant_id TEXT,
  participant_number TEXT,
  student_name TEXT,
  class_name TEXT,
  exam_id TEXT,
  exam_title TEXT,
  subject TEXT,
  answered_count INTEGER,
  correct_count INTEGER,
  total_questions INTEGER,
  score NUMERIC(5,2),
  tab_switch_count INTEGER,
  status TEXT,
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '15s'
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 2000);
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,reset,recap,database');
  RETURN QUERY
  SELECT
    er.id, er.participant_id, er.participant_number, er.student_name, er.class_name,
    er.exam_id, er.exam_title, er.subject, er.answered_count, er.correct_count,
    er.total_questions, er.score, er.tab_switch_count, er.status,
    er.started_at, er.submitted_at, er.updated_at
  FROM public.exam_results er
  WHERE (p_exam_id IS NULL OR TRIM(p_exam_id) = '' OR er.exam_id = p_exam_id)
    AND (
      p_updated_after IS NULL
      OR (er.updated_at, er.id) > (p_updated_after, COALESCE(p_after_id, ''))
    )
  ORDER BY er.updated_at ASC, er.id ASC
  LIMIT v_limit;
END;
$$;

DROP FUNCTION IF EXISTS public.staff_list_exam_result_ids(TEXT, TEXT, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION public.staff_list_exam_result_ids(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL,
  p_after_id TEXT DEFAULT '',
  p_limit INTEGER DEFAULT 2000
)
RETURNS TABLE (id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10s'
AS $$
DECLARE
  v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 5000);
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,reset,recap,database');
  RETURN QUERY
  SELECT er.id
  FROM public.exam_results er
  WHERE COALESCE(p_after_id, '') = '' OR er.id > p_after_id
  ORDER BY er.id ASC
  LIMIT v_limit;
END;
$$;

DROP FUNCTION IF EXISTS public.staff_count_exam_results(TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.staff_count_exam_results(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10s'
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,reset,recap,database');
  RETURN (SELECT COUNT(*)::INTEGER FROM public.exam_results);
END;
$$;

DROP FUNCTION IF EXISTS public.staff_get_exam_results_by_ids(TEXT, TEXT, TEXT[], BOOLEAN);
CREATE OR REPLACE FUNCTION public.staff_get_exam_results_by_ids(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL,
  p_result_ids TEXT[] DEFAULT NULL,
  p_include_answers BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  id TEXT,
  participant_id TEXT,
  participant_number TEXT,
  student_name TEXT,
  class_name TEXT,
  exam_id TEXT,
  exam_title TEXT,
  subject TEXT,
  answers JSONB,
  flagged_questions TEXT[],
  question_ids TEXT[],
  answered_count INTEGER,
  correct_count INTEGER,
  total_questions INTEGER,
  score NUMERIC(5,2),
  tab_switch_count INTEGER,
  status TEXT,
  started_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '15s'
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,reset,recap,database');
  IF p_result_ids IS NULL OR array_length(p_result_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    er.id, er.participant_id, er.participant_number, er.student_name, er.class_name,
    er.exam_id, er.exam_title, er.subject,
    CASE WHEN COALESCE(p_include_answers, FALSE) THEN er.answers ELSE '{}'::jsonb END,
    CASE WHEN COALESCE(p_include_answers, FALSE) THEN er.flagged_questions ELSE '{}'::text[] END,
    CASE WHEN COALESCE(p_include_answers, FALSE) THEN er.question_ids ELSE NULL END,
    er.answered_count, er.correct_count, er.total_questions, er.score,
    er.tab_switch_count, er.status, er.started_at, er.submitted_at, er.updated_at
  FROM public.exam_results er
  WHERE er.id = ANY(p_result_ids);
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
SET statement_timeout = '25s'
SET lock_timeout = '3s'
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

-- Preflight status aktif peserta (validasi token untuk anon agar mencegah enumerasi)
DROP FUNCTION IF EXISTS public.check_participant_active(TEXT);
DROP FUNCTION IF EXISTS public.check_participant_active(TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.check_participant_active(
  p_participant_number TEXT,
  p_token TEXT DEFAULT NULL
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
SET statement_timeout = '5s'
AS $$
DECLARE
  v_jwt_role TEXT := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role', ''),
    ''
  );
  v_is_privileged BOOLEAN := v_jwt_role IN ('service_role', 'supabase_admin')
    OR (v_jwt_role = '' AND session_user IN ('postgres', 'service_role', 'supabase_admin'));
  v_norm_num TEXT := UPPER(TRIM(COALESCE(p_participant_number, '')));
  v_norm_tok TEXT := UPPER(TRIM(COALESCE(p_token, '')));
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
    RETURN;
  END IF;

  IF NOT v_is_privileged THEN
    IF v_norm_tok = '' OR UPPER(TRIM(COALESCE(v_rec.token, ''))) <> v_norm_tok THEN
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_rec.id,
    v_rec.participant_number,
    v_rec.full_name,
    v_rec.class_name,
    v_rec.is_active,
    v_rec.created_at;
END;
$$;

-- RPC Staf Terverifikasi untuk manajemen participants & exam_schedules
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
SET statement_timeout = '15s'
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,participants,cards,recap,reset,database');
  RETURN QUERY
    SELECT p.id, p.participant_number, p.token, p.full_name, p.class_name, p.is_active, p.created_at
    FROM public.participants p
    ORDER BY p.class_name ASC, p.participant_number ASC;
END;
$$;

CREATE OR REPLACE FUNCTION public.staff_count_participants(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '10s'
AS $$
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'dashboard,participants,cards,recap,reset,database');
  RETURN (SELECT COUNT(*)::INTEGER FROM public.participants);
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
REVOKE ALL ON FUNCTION public.count_answered_entries(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.score_matching_answer(TEXT, JSONB, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_participant_number_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_exam_results_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_base64_question_images_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_verified_staff(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_caller_admin_staff(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_verified_participant(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_server_time() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_student_questions(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_questions_sync_meta(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_question_coverage_summary(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_finish_exam_results(TEXT[], INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_participant_login(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_student_bootstrap(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_login_bundle(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_get_my_results(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_check_exam_status(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_participant_active(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_staff_login(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_questions_batch(JSONB, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_question_by_id(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_accounts(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_account(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], TEXT[], BOOLEAN, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_account(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_school_profile(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_exam_results(TEXT, TEXT, TEXT[], TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_exam_results_batch(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_exam_results_summary(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_exam_result_ids(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_count_exam_results(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_get_exam_results_by_ids(TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_participants(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_count_participants(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_participants_batch(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_participants(TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_upsert_exam_schedules_batch(TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_delete_exam_schedules(TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_student_questions(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[], TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[], TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_participant_login(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_student_bootstrap(TIMESTAMPTZ) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_login_bundle(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_get_my_results(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_check_exam_status(TEXT, TEXT, TEXT, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_participant_active(TEXT, TEXT) TO anon, authenticated, service_role;
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
GRANT EXECUTE ON FUNCTION public.staff_list_exam_results_summary(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_list_exam_result_ids(TEXT, TEXT, TEXT, INTEGER) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_count_exam_results(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_get_exam_results_by_ids(TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_list_participants(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_count_participants(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upsert_participants_batch(TEXT, TEXT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_delete_participants(TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_upsert_exam_schedules_batch(TEXT, TEXT, JSONB) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_delete_exam_schedules(TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated, service_role;

-- 7. Tabel & RPC Tiket Upload Gambar Staf Terverifikasi (tanpa open anon INSERT & tanpa Base64 di DB)
CREATE TABLE IF NOT EXISTS public.staff_upload_tickets (
  object_name TEXT PRIMARY KEY,
  staff_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_upload_tickets_expires
  ON public.staff_upload_tickets(expires_at);

REVOKE ALL ON TABLE public.staff_upload_tickets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_upload_tickets TO service_role;
ALTER TABLE public.staff_upload_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct access staff_upload_tickets" ON public.staff_upload_tickets;
CREATE POLICY "Deny direct access staff_upload_tickets" ON public.staff_upload_tickets
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.staff_issue_image_upload_ticket(
  p_staff_user_id TEXT DEFAULT NULL,
  p_staff_password_sha256 TEXT DEFAULT NULL,
  p_prefix TEXT DEFAULT 'q',
  p_ext TEXT DEFAULT 'webp'
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '8s'
AS $$
DECLARE
  v_prefix TEXT := LOWER(TRIM(COALESCE(p_prefix, 'q')));
  v_ext TEXT := LOWER(TRIM(COALESCE(p_ext, 'webp')));
  v_object_name TEXT;
BEGIN
  PERFORM public.assert_verified_staff(p_staff_user_id, p_staff_password_sha256, 'questions');

  IF v_prefix NOT IN ('q', 'opt', 'match-l', 'match-r') THEN
    v_prefix := 'q';
  END IF;

  IF v_ext = 'jpeg' THEN
    v_ext := 'jpg';
  END IF;
  IF v_ext NOT IN ('webp', 'jpg', 'png', 'gif') THEN
    RAISE EXCEPTION 'Ekstensi gambar tidak diizinkan (gunakan webp, jpg, png, atau gif).'
      USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.staff_upload_tickets WHERE expires_at < NOW();

  v_object_name :=
    v_prefix
    || '/'
    || (floor(extract(epoch FROM clock_timestamp()) * 1000))::BIGINT::TEXT
    || '-'
    || substring(replace(gen_random_uuid()::TEXT, '-', '') FROM 1 FOR 12)
    || '.'
    || v_ext;

  INSERT INTO public.staff_upload_tickets (object_name, staff_user_id, expires_at)
  VALUES (
    v_object_name,
    COALESCE(NULLIF(LOWER(TRIM(COALESCE(p_staff_user_id, ''))), ''), 'privileged'),
    NOW() + INTERVAL '5 minutes'
  );

  RETURN v_object_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_authorized_question_image_upload(
  p_object_name TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_upload_tickets t
    WHERE t.object_name = p_object_name
      AND t.expires_at > NOW()
  );
$$;

REVOKE ALL ON FUNCTION public.staff_issue_image_upload_ticket(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_authorized_question_image_upload(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_issue_image_upload_ticket(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_authorized_question_image_upload(TEXT) TO anon, authenticated, service_role;

-- Bucket Supabase Storage untuk gambar soal (menggantikan Base64 di database) dengan batas MIME & ukuran ketat (2 MB)
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'question-images',
    'question-images',
    true,
    2097152,
    ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  )
  ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = 2097152,
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
  DROP POLICY IF EXISTS "Privileged insert question-images" ON storage.objects;
  CREATE POLICY "Privileged insert question-images" ON storage.objects
    FOR INSERT TO authenticated, service_role
    WITH CHECK (
      bucket_id = 'question-images'
      AND name ~ '^(q|opt|match-l|match-r)/[0-9]+-[a-z0-9]+\\.(png|jpg|jpeg|webp|gif)$'
    );

  DROP POLICY IF EXISTS "Verified staff ticket insert question-images" ON storage.objects;
  CREATE POLICY "Verified staff ticket insert question-images" ON storage.objects
    FOR INSERT TO anon
    WITH CHECK (
      bucket_id = 'question-images'
      AND name ~ '^(q|opt|match-l|match-r)/[0-9]+-[a-z0-9]+\\.(png|jpg|jpeg|webp|gif)$'
      AND public.is_authorized_question_image_upload(name)
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

