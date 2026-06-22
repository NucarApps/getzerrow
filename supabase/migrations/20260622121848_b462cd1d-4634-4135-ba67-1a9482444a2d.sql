-- Raise the live-lane batch so a burst of new mail finishes server-side
-- faster (still runs every 5s, independent of any browser session).
DO $$ BEGIN PERFORM cron.unschedule('gmail-process-live-5s'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'gmail-process-live-5s',
  '5 seconds',
  $$ SELECT private.cron_post('/api/public/gmail-process-jobs?limit=50&priority=0'); $$
);