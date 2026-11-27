-- ============================================================================
-- MIGRASI HARDENING & SKALABILITAS NUSANTARA CBT (800-1.000+ SISWA SERENTAK)
-- Target: Supabase Pro (PostgreSQL) — 100% Idempotent & Zero Breaking Changes
--
-- Kontrak Skema yang Dijaga Ketat:
-- 1. exam_results.student_name (bukan participant_name)
-- 2. exam_results.status CHECK (status IN ('in_progress', 'submitted', 'flagged'))
-- 3. staff_accounts.role_type CHECK (role_type IN ('admin', 'proktor', 'guru_mapel', 'custom'))
-- 4. Kompatibilitas parameter RPC frontend (parameter baru memakai DEFAULT NULL)
-- ============================================================================

-- ============================================================================
-- BAGIAN 1: TUNING STORAGE, AUTOVACUUM, KOLOM answered_count & INDEKS
-- ============================================================================

ALTER TABLE public.exam_results
  ADD COLUMN IF NOT EXISTS answered_count INTEGER NOT NULL DEFAULT 0;

-- Tuning HOT update & autovacuum agresif untuk ~1.000 siswa autosave/submit serentak
ALTER TABLE public.exam_results SET (
  fillfactor = 70,
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 100,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 50,
  autovacuum_vacuum_cost_limit = 1000
);

-- Helper IMMUTABLE untuk menghitung jumlah soal terjawab secara identik dengan frontend
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
            SELECT 1
            FROM jsonb_each_text(v_obj) e
            WHERE NULLIF(TRIM(COALESCE(e.value, '')), '') IS NOT NULL
          ) THEN
            v_count := v_count + 1;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
      ELSE
        v_count := v_count + 1;
      END IF;
    ELSIF jsonb_typeof(v_kv.value) = 'object' THEN
      IF EXISTS (
        SELECT 1
        FROM jsonb_each_text(v_kv.value) e
        WHERE NULLIF(TRIM(COALESCE(e.value, '')), '') IS NOT NULL
      ) THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN v_count;
END;
$$;

-- Helper IMMUTABLE untuk penilaian soal Menjodohkan (mendukung set-based SQL CTE)
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
    RETURN QUERY SELECT
      (v_pts * v_pair_matched::NUMERIC / v_pair_total::NUMERIC),
      (v_pair_matched = v_pair_total);
  ELSE
    RETURN QUERY SELECT 0::NUMERIC, FALSE;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RETURN QUERY SELECT 0::NUMERIC, FALSE;
END;
$$;

-- Trigger gabungan untuk exam_results: normalisasi participant_number + auto-maintain answered_count
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

DROP TRIGGER IF EXISTS trg_normalize_participant_number_results ON public.exam_results;
DROP TRIGGER IF EXISTS trg_normalize_exam_results ON public.exam_results;
CREATE TRIGGER trg_normalize_exam_results
  BEFORE INSERT OR UPDATE ON public.exam_results
  FOR EACH ROW
  EXECUTE FUNCTION public.normalize_exam_results_trigger();

-- Backfill idempoten participant_number & answered_count untuk baris lama
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

-- Hapus indeks redundan / fungsional yang menambah beban write & bloat
DROP INDEX IF EXISTS public.idx_participants_number;
DROP INDEX IF EXISTS public.idx_participants_number_lower;
DROP INDEX IF EXISTS public.idx_participants_number_upper;
DROP INDEX IF EXISTS public.idx_exam_results_class;
DROP INDEX IF EXISTS public.idx_exam_results_subject;
DROP INDEX IF EXISTS public.idx_exam_results_status;
DROP INDEX IF EXISTS public.idx_exam_results_participant_lower_exam;
DROP INDEX IF EXISTS public.idx_exam_results_exam_status;
DROP INDEX IF EXISTS public.idx_exam_results_updated_at;

-- Tambahkan indeks parsial & composite cursor untuk query auto-finalize & Admin delta-sync
CREATE INDEX IF NOT EXISTS idx_exam_results_active_exam_started
  ON public.exam_results (exam_id, started_at ASC)
  WHERE status = 'in_progress' AND submitted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_exam_results_delta_cursor
  ON public.exam_results (updated_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_exam_schedules_active
  ON public.exam_schedules (id)
  WHERE is_active = TRUE;

-- Guard DB: cegah penyimpanan baru gambar Base64 (data:image/...) di tabel public.questions
CREATE OR REPLACE FUNCTION public.reject_base64_question_images_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.question_image_url IS DISTINCT FROM OLD.question_image_url)
     AND COALESCE(NEW.question_image_url, '') ~* '^\s*data:image/' THEN
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

DROP TRIGGER IF EXISTS trg_reject_base64_question_images ON public.questions;
CREATE TRIGGER trg_reject_base64_question_images
  BEFORE INSERT OR UPDATE ON public.questions
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_base64_question_images_trigger();

-- ============================================================================
-- BAGIAN 2: LOCKDOWN RLS & GRANT PADA exam_results + STORAGE question-images
-- ============================================================================

-- Cabut SELURUH akses langsung tabel exam_results dari PUBLIC dan anon
REVOKE ALL ON TABLE public.exam_results FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.exam_results TO authenticated, service_role;

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

-- Perketat Supabase Storage bucket `question-images`: batasi 2MB & hapus open anon INSERT
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
      AND name ~ '^(q|opt|match-l|match-r)/[0-9]+-[a-z0-9]+\.(png|jpg|jpeg|webp|gif)$'
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

-- ============================================================================
-- BAGIAN 3: HARDENING HELPER VERIFIKASI STAF (role_type) & PESERTA (token)
-- ============================================================================

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
  -- Hanya lewati verifikasi jika caller benar-benar service_role/supabase_admin atau SQL Editor (TIDAK bypass JWT authenticated sembarangan)
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

-- Helper internal untuk memverifikasi apakah caller adalah administrator (role_type = 'admin' atau service_role)
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
  WHERE LOWER(TRIM(s.user_id)) = v_norm_id
    AND s.is_active = TRUE
  ORDER BY s.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN v_role = 'admin';
  END IF;

  RETURN v_norm_id = 'admin';
END;
$$;

-- Helper internal verifikasi peserta & token untuk seluruh Student RPC
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

  -- Bypass token hanya untuk service_role/supabase_admin atau SQL Editor
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

-- ============================================================================
-- BAGIAN 4: STUDENT RPCs AMAN (VALIDASI TOKEN, SERVER started_at, ZERO ANON LEAK)
-- ============================================================================

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

    -- Pastikan hanya soal dari jadwal aktif untuk kelas peserta yang dapat diambil
    IF NOT EXISTS (
      SELECT 1
      FROM public.exam_schedules s
      WHERE s.is_active = TRUE
        AND s.target_classes @> ARRAY[v_effective_class]
        AND (p_subject IS NULL OR TRIM(p_subject) = '' OR LOWER(TRIM(s.subject)) = LOWER(TRIM(p_subject)))
    ) THEN
      RAISE EXCEPTION 'No active exam schedule for participant class/subject' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    q.id,
    q.subject,
    q.target_classes,
    COALESCE(q.question_type, 'multiple_choice'),
    q.question_text,
    q.question_image_url,
    q.options,
    q.points,
    q.order_index
  FROM public.questions q
  WHERE q.target_classes @> ARRAY[v_effective_class]
    AND (p_subject IS NULL OR TRIM(p_subject) = '' OR LOWER(TRIM(q.subject)) = LOWER(TRIM(p_subject)))
  ORDER BY q.order_index ASC, q.id ASC;
END;
$$;

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

  -- Untuk caller anon, wajib cocokkan token agar tidak bisa enumerasi data peserta lain
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

-- RPC Pengganti SELECT anon langsung untuk mengambil seluruh hasil ujian milik siswa yang terverifikasi
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
    er.id,
    er.participant_id,
    er.participant_number,
    er.student_name,
    er.class_name,
    er.exam_id,
    er.exam_title,
    er.subject,
    CASE WHEN er.status = 'in_progress' THEN er.answers ELSE '{}'::jsonb END,
    CASE WHEN er.status = 'in_progress' THEN er.flagged_questions ELSE '{}'::text[] END,
    CASE WHEN er.status = 'in_progress' THEN er.question_ids ELSE NULL END,
    er.answered_count,
    er.correct_count,
    er.total_questions,
    er.score,
    er.tab_switch_count,
    er.status,
    er.started_at,
    er.submitted_at,
    er.updated_at
  FROM public.exam_results er
  WHERE er.participant_number = COALESCE(NULLIF(v_participant.participant_number, ''), v_norm_num);
END;
$$;

-- RPC Pengganti SELECT anon langsung untuk cek kunci / status / recovery 1 sesi ujian milik siswa
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
    er.id,
    er.participant_id,
    er.participant_number,
    er.student_name,
    er.class_name,
    er.exam_id,
    er.exam_title,
    er.subject,
    CASE WHEN COALESCE(p_include_full, FALSE) THEN er.answers ELSE '{}'::jsonb END,
    CASE WHEN COALESCE(p_include_full, FALSE) THEN er.flagged_questions ELSE '{}'::text[] END,
    CASE WHEN COALESCE(p_include_full, FALSE) THEN er.question_ids ELSE NULL END,
    er.answered_count,
    er.correct_count,
    er.total_questions,
    er.score,
    er.tab_switch_count,
    er.status,
    er.started_at,
    er.submitted_at,
    er.updated_at
  FROM public.exam_results er
  WHERE er.participant_number = COALESCE(NULLIF(v_participant.participant_number, ''), v_norm_num)
    AND er.exam_id = p_exam_id
  LIMIT 1;
END;
$$;

-- Perbarui verify_participant_login & student_login_bundle (hapus fallback Seq Scan & sertakan answered_count)
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
SET statement_timeout = '5s'
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

-- Upsert Progres Ujian Atomik: Validasi Token + Server-Authoritative started_at + Lock Timeout
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

  SELECT * INTO v_sched
  FROM public.exam_schedules s
  WHERE s.id = p_exam_id
  LIMIT 1;

  IF NOT v_is_privileged THEN
    IF NOT FOUND OR NOT COALESCE(v_sched.is_active, FALSE)
       OR NOT (v_sched.target_classes @> ARRAY[v_effective_class_name]) THEN
      -- Izinkan update jika baris in_progress sudah terlanjur ada, namun tolak INSERT sesi baru ke jadwal non-aktif
      IF NOT EXISTS (
        SELECT 1 FROM public.exam_results er
        WHERE er.participant_number = v_norm_participant AND er.exam_id = p_exam_id
      ) THEN
        RAISE EXCEPTION 'Exam schedule is inactive or unavailable for class' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  v_effective_subject := COALESCE(NULLIF(TRIM(v_sched.subject), ''), COALESCE(p_subject, ''));
  -- Server-authoritative started_at: untuk anon SELALU pakai NOW() saat INSERT, immutable saat UPDATE
  v_effective_started_at := CASE
    WHEN v_is_privileged THEN COALESCE(p_started_at, NOW())
    ELSE NOW()
  END;

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

-- Submit & Penilaian Server-Side: Validasi Token + Set-Based Scoring + Server started_at + Timeouts
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
  v_sched_subject TEXT;
  v_sched_title TEXT;
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

  -- Penilaian single-pass penuh (termasuk soal Menjodohkan via score_matching_answer)
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

-- ============================================================================
-- BAGIAN 5: SET-BASED BATCH FINALIZATION (TANPA RBAR LOOP) & ADMIN EGRESS RPCs
-- ============================================================================

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

-- RPC Delta-Sync Ringkas untuk Monitoring Admin (HEMAT EGRESS 80-95%: tanpa answers JSONB, keyset cursor (updated_at, id))
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
    er.id,
    er.participant_id,
    er.participant_number,
    er.student_name,
    er.class_name,
    er.exam_id,
    er.exam_title,
    er.subject,
    er.answered_count,
    er.correct_count,
    er.total_questions,
    er.score,
    er.tab_switch_count,
    er.status,
    er.started_at,
    er.submitted_at,
    er.updated_at
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

-- RPC Rekonsiliasi ID Terhapus untuk Admin (keyset pagination hanya kolom id)
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

-- RPC Hitung Total Hasil Ujian untuk Admin
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

-- RPC Ambil Detail/Ringkasan Hasil Ujian Berdasarkan Daftar ID untuk Admin (mis. pasca force_finish)
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
    er.id,
    er.participant_id,
    er.participant_number,
    er.student_name,
    er.class_name,
    er.exam_id,
    er.exam_title,
    er.subject,
    CASE WHEN COALESCE(p_include_answers, FALSE) THEN er.answers ELSE '{}'::jsonb END,
    CASE WHEN COALESCE(p_include_answers, FALSE) THEN er.flagged_questions ELSE '{}'::text[] END,
    CASE WHEN COALESCE(p_include_answers, FALSE) THEN er.question_ids ELSE NULL END,
    er.answered_count,
    er.correct_count,
    er.total_questions,
    er.score,
    er.tab_switch_count,
    er.status,
    er.started_at,
    er.submitted_at,
    er.updated_at
  FROM public.exam_results er
  WHERE er.id = ANY(p_result_ids);
END;
$$;

-- ============================================================================
-- BAGIAN 6: PERKETAT TAB PRIVILEGE, ANTI-ESKALASI & TIMEOUT PADA STAFF RPCs LAIN
-- ============================================================================

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

  -- Blokir eskalasi hak akses: non-admin dilarang membuat/mengubah akun role_type='admin' atau user_id='admin'
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

-- Tambahkan explicit statement_timeout & lock_timeout pada batch write RPC lainnya
ALTER FUNCTION public.upsert_questions_batch(JSONB, TEXT, TEXT)
  SET statement_timeout = '20s', SET lock_timeout = '3s';
ALTER FUNCTION public.delete_question_by_id(TEXT, TEXT, TEXT)
  SET statement_timeout = '10s', SET lock_timeout = '3s';
ALTER FUNCTION public.staff_upsert_exam_results_batch(TEXT, TEXT, JSONB)
  SET statement_timeout = '25s', SET lock_timeout = '3s';
ALTER FUNCTION public.staff_upsert_participants_batch(TEXT, TEXT, JSONB)
  SET statement_timeout = '25s', SET lock_timeout = '3s';
ALTER FUNCTION public.staff_delete_participants(TEXT, TEXT, TEXT[], BOOLEAN)
  SET statement_timeout = '15s', SET lock_timeout = '3s';
ALTER FUNCTION public.staff_upsert_exam_schedules_batch(TEXT, TEXT, JSONB)
  SET statement_timeout = '15s', SET lock_timeout = '3s';
ALTER FUNCTION public.staff_delete_exam_schedules(TEXT, TEXT, TEXT[], BOOLEAN)
  SET statement_timeout = '15s', SET lock_timeout = '3s';
ALTER FUNCTION public.staff_upsert_school_profile(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT)
  SET statement_timeout = '10s', SET lock_timeout = '3s';

-- ============================================================================
-- BAGIAN 7: HAK EKSEKUSI FUNGSI (REVOKE PUBLIC + GRANT TERBATAS)
-- ============================================================================

REVOKE ALL ON FUNCTION public.count_answered_entries(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.score_matching_answer(TEXT, JSONB, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.normalize_exam_results_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_base64_question_images_trigger() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_verified_staff(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_caller_admin_staff(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assert_verified_participant(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_student_questions(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_participant_active(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_get_my_results(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.student_check_exam_status(TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[], TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.force_finish_exam_results(TEXT[], INTEGER, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_exam_results_summary(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_list_exam_result_ids(TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_count_exam_results(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.staff_get_exam_results_by_ids(TEXT, TEXT, TEXT[], BOOLEAN) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_student_questions(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_participant_active(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_get_my_results(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.student_check_exam_status(TEXT, TEXT, TEXT, BOOLEAN) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_exam_progress(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, INTEGER, TIMESTAMPTZ, TEXT[], TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_exam_and_score(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT[], INTEGER, TIMESTAMPTZ, INTEGER, TEXT[], TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auto_finalize_expired_results(TEXT, TIMESTAMPTZ, INTEGER, INTEGER, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.force_finish_exam_results(TEXT[], INTEGER, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_list_exam_results_summary(TEXT, TEXT, TIMESTAMPTZ, TEXT, INTEGER, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_list_exam_result_ids(TEXT, TEXT, TEXT, INTEGER) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_count_exam_results(TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.staff_get_exam_results_by_ids(TEXT, TEXT, TEXT[], BOOLEAN) TO anon, authenticated, service_role;

-- Pastikan exam_results tetap tidak ikut publikasi Realtime (mencegah badai WAL/broadcast)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime DROP TABLE public.exam_results;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Refresh statistik planner setelah migrasi indeks & kolom
ANALYZE public.participants;
ANALYZE public.exam_schedules;
ANALYZE public.questions;
ANALYZE public.exam_results;
ANALYZE public.staff_accounts;
