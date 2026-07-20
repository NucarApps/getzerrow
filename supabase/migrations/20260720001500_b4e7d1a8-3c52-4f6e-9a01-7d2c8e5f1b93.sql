-- Repair/reproducibility migration for the photo storage buckets.
--
-- Two gaps left photo features silently broken on fresh environments:
--   1. The contact-photos bucket was never created by any migration —
--      20260718140923 added only its storage.objects RLS policies. (The
--      hosted project's bucket was created out-of-band.)
--   2. The company-logos bucket insert in 20260719200000 did not take effect
--      on the hosted project (the migration appears to have aborted partway;
--      later migrations are applied but the bucket is absent).
--
-- Everything below is idempotent so it is safe to run on environments where
-- any subset already exists.

INSERT INTO storage.buckets (id, name, public)
VALUES ('contact-photos', 'contact-photos', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('company-logos', 'company-logos', true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS logo_url text;

-- Re-create the company-logos policies from 20260719200000, guarded so this
-- succeeds whether or not the originals were created before that migration
-- aborted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Company logos are publicly readable'
  ) THEN
    CREATE POLICY "Company logos are publicly readable"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'company-logos');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Users upload own company logos'
  ) THEN
    CREATE POLICY "Users upload own company logos"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'company-logos'
      AND auth.uid()::text = (storage.foldername(name))[1]
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Users update own company logos'
  ) THEN
    CREATE POLICY "Users update own company logos"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
      bucket_id = 'company-logos'
      AND auth.uid()::text = (storage.foldername(name))[1]
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'Users delete own company logos'
  ) THEN
    CREATE POLICY "Users delete own company logos"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'company-logos'
      AND auth.uid()::text = (storage.foldername(name))[1]
    );
  END IF;
END $$;
