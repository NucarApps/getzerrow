ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS avatar_source text NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'contacts_avatar_source_check'
      AND conrelid = 'public.contacts'::regclass
  ) THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_avatar_source_check
      CHECK (avatar_source IN ('unknown', 'user_upload', 'carddav', 'google', 'company_logo'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.company_logo_hashes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  domain text,
  sha256 text NOT NULL,
  source text NOT NULL DEFAULT 'observed',
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id, sha256)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_logo_hashes TO authenticated;
GRANT ALL ON public.company_logo_hashes TO service_role;

ALTER TABLE public.company_logo_hashes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'company_logo_hashes'
      AND policyname = 'Users can manage their own company logo hashes'
  ) THEN
    CREATE POLICY "Users can manage their own company logo hashes"
      ON public.company_logo_hashes
      FOR ALL
      TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS company_logo_hashes_user_company_idx
  ON public.company_logo_hashes(user_id, company_id);

CREATE INDEX IF NOT EXISTS company_logo_hashes_user_sha_idx
  ON public.company_logo_hashes(user_id, sha256);