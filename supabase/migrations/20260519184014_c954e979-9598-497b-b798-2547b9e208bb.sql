
-- Wipe data tied to the old shared-connector setup
DELETE FROM public.reply_drafts;
DELETE FROM public.folder_examples;
DELETE FROM public.folder_filters;
DELETE FROM public.emails;
DELETE FROM public.folders;
DELETE FROM public.sync_state;

-- New table: one row per user per connected Gmail mailbox
CREATE TABLE public.gmail_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  history_id TEXT,
  watch_expiration TIMESTAMPTZ,
  last_poll_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, email_address)
);

CREATE INDEX gmail_accounts_email_idx ON public.gmail_accounts (email_address);

ALTER TABLE public.gmail_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own gmail accounts"
  ON public.gmail_accounts FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own gmail accounts"
  ON public.gmail_accounts FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own gmail accounts"
  ON public.gmail_accounts FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own gmail accounts"
  ON public.gmail_accounts FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER gmail_accounts_set_updated_at
  BEFORE UPDATE ON public.gmail_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Link existing tables to gmail_accounts
ALTER TABLE public.emails
  ADD COLUMN gmail_account_id UUID NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE;
CREATE INDEX emails_gmail_account_id_idx ON public.emails (gmail_account_id);

ALTER TABLE public.folders
  ADD COLUMN gmail_account_id UUID NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE;
CREATE INDEX folders_gmail_account_id_idx ON public.folders (gmail_account_id);

ALTER TABLE public.folder_examples
  ADD COLUMN gmail_account_id UUID NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE;
CREATE INDEX folder_examples_gmail_account_id_idx ON public.folder_examples (gmail_account_id);
