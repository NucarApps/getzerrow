ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS calendar_guard_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calendar_access boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS calendar_synced_at timestamp with time zone;

CREATE TABLE public.calendar_contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  gmail_account_id uuid NOT NULL,
  email_address text NOT NULL,
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (gmail_account_id, email_address)
);

CREATE INDEX idx_calendar_contacts_account ON public.calendar_contacts (gmail_account_id);

GRANT SELECT ON public.calendar_contacts TO authenticated;
GRANT ALL ON public.calendar_contacts TO service_role;

ALTER TABLE public.calendar_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own calendar contacts"
ON public.calendar_contacts
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);