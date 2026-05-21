DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('gmail-backfill-tick'); EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

SELECT cron.schedule(
  'gmail-backfill-tick', '* * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-backfill-tick?limit=4'); $$
);