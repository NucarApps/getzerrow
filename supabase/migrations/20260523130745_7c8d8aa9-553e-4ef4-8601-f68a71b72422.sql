DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'gmail-reconcile-15m') THEN
    PERFORM cron.unschedule('gmail-reconcile-15m');
  END IF;
END $$;

SELECT cron.schedule(
  'gmail-reconcile-15m',
  '*/15 * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-reconcile'); $$
);