ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS surfaced_to_inbox boolean NOT NULL DEFAULT false;