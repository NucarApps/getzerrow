ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS last_reconcile_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS gmail_accounts_reconcile_due_idx
  ON public.gmail_accounts (needs_reconnect, last_reconcile_at NULLS FIRST);

DO $$ BEGIN
  PERFORM cron.unschedule('gmail-poll-2m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'gmail-poll-2m',
  '*/2 * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-poll'); $$
);

DO $$ BEGIN
  PERFORM cron.unschedule('gmail-reconcile-15m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'gmail-reconcile-5m',
  '*/5 * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-reconcile?max_accounts=2'); $$
);