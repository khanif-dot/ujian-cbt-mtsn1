-- ============================================================================
-- MIGRASI: PENULISAN ARAB (UTF-8), BARIS BARU (\n), & UPLOAD GAMBAR STORAGE AMAN
-- Tujuan:
--   1. Memperbaiki upload gambar soal/opsi/menjodohkan bagi staf terverifikasi
--      (Admin, Proktor, Guru Mapel) tanpa memerlukan Service Role Key di browser
--      dan tanpa membuka anon INSERT bebas pada Storage.
--   2. Tetap memblokir Base64 di tabel public.questions agar payload unduhan
--      soal oleh 800-1.000+ perangkat peserta tetap sangat ringan (<20 KB JSON)
--      dan seluruh gambar dimuat langsung dari Supabase Storage CDN (cache 1 tahun).
--   3. Menjamin teks UTF-8 (termasuk huruf Arab & harakat) serta karakter baris
--      baru (\n) tersimpan utuh dan konsisten di Postgres.
-- Idempoten — aman dijalankan berulang di Supabase SQL Editor.
-- ============================================================================

-- 1. Tabel tiket upload gambar sementara khusus staf terverifikasi (berlaku 5 menit)
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

-- 2. RPC penerbitan path upload gambar soal yang terotorisasi untuk staf Bank Soal
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

  -- Bersihkan tiket kedaluwarsa agar tabel tetap ringan
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

-- 3. Helper validasi tiket untuk RLS INSERT pada storage.objects
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

-- 4. Sinkronisasi normalisasi baris baru (\r\n -> \n) pada upsert_questions_batch (UTF-8 Arab & multi-baris tetap utuh)
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

    v_question_text := replace(replace(COALESCE(item ->> 'question_text', ''), E'\r\n', E'\n'), E'\r', E'\n');

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

-- 5. Bucket & Storage RLS policy: CDN publik untuk baca siswa, tiket staf terverifikasi untuk upload
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

  DROP POLICY IF EXISTS "Verified staff ticket insert question-images" ON storage.objects;
  CREATE POLICY "Verified staff ticket insert question-images" ON storage.objects
    FOR INSERT TO anon
    WITH CHECK (
      bucket_id = 'question-images'
      AND name ~ '^(q|opt|match-l|match-r)/[0-9]+-[a-z0-9]+\.(png|jpg|jpeg|webp|gif)$'
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
