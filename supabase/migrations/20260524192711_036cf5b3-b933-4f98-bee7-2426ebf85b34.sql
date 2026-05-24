
-- 1. Reset the cron secret in private settings to a fresh value
UPDATE private.cron_settings
   SET value = 'aca56fcb4c0f597cc5702d4aea06a3753e29aec507dc6bee830fafca8e9bbd51'
 WHERE name = 'cron_secret';

-- 2. Reschedule the two jobs that still used the (now-rejected) apikey header
SELECT cron.unschedule('gmail-process-live-5s');
SELECT cron.unschedule('relearn-folders-hourly');

SELECT cron.schedule(
  'gmail-process-live-5s',
  '5 seconds',
  $$ SELECT private.cron_post('/api/public/gmail-process-jobs?limit=25&priority=0'); $$
);

SELECT cron.schedule(
  'relearn-folders-hourly',
  '7 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/relearn-folders'); $$
);
