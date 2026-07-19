ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS record_declined_meetings boolean NOT NULL DEFAULT false;