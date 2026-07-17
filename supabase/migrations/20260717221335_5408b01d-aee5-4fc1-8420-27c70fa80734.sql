-- Schedule Google Contacts two-way sync every 15 minutes.
DO $$
BEGIN
  PERFORM cron.unschedule('google-contacts-sync-15m');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'google-contacts-sync-15m',
  '*/15 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/google-contacts-sync'); $$
);

INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'google contacts two-way sync scheduled (every 15 min)');