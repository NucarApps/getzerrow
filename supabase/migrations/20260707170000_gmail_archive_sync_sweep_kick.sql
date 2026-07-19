-- Archive-sync repair: make the safety sweep dependable and kick a
-- one-time full cleanup so already-stale rows (archived in Gmail but
-- still unarchived in Zerrow) get corrected immediately.
--
-- Context: the history-walk fix (app code) makes Gmail archive /
-- un-archive / trash / spam signals apply within moments. This
-- migration handles the database side:
--   1. Re-assert the 5-minute reconcile schedule (idempotent). The
--      route now honors max_accounts with least-recently-reconciled
--      rotation via gmail_accounts.last_reconcile_at (column + index
--      already exist from 20260629200036).
--   2. Fire a one-time wide reconcile right now so stale emails are
--      repaired without waiting for the next tick.

DO $$ BEGIN
  PERFORM cron.unschedule('gmail-reconcile-5m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'gmail-reconcile-5m',
  '*/5 * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-reconcile?max_accounts=2'); $$
);

-- One-time cleanup kick: wide account window so every connected account
-- gets swept in this single run. private.cron_post carries the stored
-- CRON_SECRET, so this is the same authorized call pg_cron makes.
SELECT private.cron_post('/api/public/gmail-reconcile?max_accounts=50');
