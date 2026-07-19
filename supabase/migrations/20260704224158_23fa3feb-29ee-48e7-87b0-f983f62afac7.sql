DO $$ BEGIN PERFORM cron.unschedule('reconcile-meetings-1m'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'reconcile-meetings-1m',
  '* * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/reconcile-meetings'); $$
);