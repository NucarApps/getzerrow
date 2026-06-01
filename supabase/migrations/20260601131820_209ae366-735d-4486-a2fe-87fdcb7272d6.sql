ALTER TABLE public.gmail_accounts
ADD COLUMN IF NOT EXISTS calendar_sync_error text;