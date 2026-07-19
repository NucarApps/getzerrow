ALTER TABLE public.google_contact_links
  ADD COLUMN IF NOT EXISTS photo_push_attempts integer NOT NULL DEFAULT 0;