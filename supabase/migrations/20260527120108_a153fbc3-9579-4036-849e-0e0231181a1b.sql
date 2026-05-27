CREATE INDEX IF NOT EXISTS gmail_accounts_email_lower_idx
  ON public.gmail_accounts (lower(email_address));