DO $$ BEGIN PERFORM cron.unschedule('schedule-meeting-bots-2m'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'schedule-meeting-bots-2m',
  '*/2 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/schedule-meeting-bots'); $$
);