DO $$ BEGIN
  CREATE TYPE public.photo_priority AS ENUM ('company_first','personal_first','personal_only');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.carddav_settings
  ADD COLUMN IF NOT EXISTS photo_priority public.photo_priority NOT NULL DEFAULT 'company_first';

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS photo_priority public.photo_priority;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS photo_priority public.photo_priority;