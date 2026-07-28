ALTER TABLE public.google_contact_links
  ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS push_backoff_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_push_error text,
  ADD COLUMN IF NOT EXISTS last_push_error_at timestamptz;

CREATE INDEX IF NOT EXISTS google_contact_links_push_backoff_idx
  ON public.google_contact_links (gmail_account_id, push_backoff_until)
  WHERE push_backoff_until IS NOT NULL;

DO $$
DECLARE rec record;
BEGIN
  FOR rec IN SELECT jobname FROM cron.job WHERE command ILIKE '%encryption-backfill%' LOOP
    PERFORM cron.unschedule(rec.jobname);
    INSERT INTO public.pubsub_events (event_type, details)
    VALUES ('migration', 'unscheduled dead cron job: ' || rec.jobname);
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.pubsub_events (event_type, details, error)
  VALUES ('migration', 'encryption-backfill unschedule skipped', SQLERRM);
END $$;

DO $$
DECLARE rec record; v_jobid bigint;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('gmail-poll-2m',                '*/2 * * * *'),
      ('contact-enrich-jobs-2m',       '1-59/2 * * * *'),
      ('schedule-meeting-bots-2m',     '1-59/2 * * * *'),
      ('gmail-reconcile-5m',           '1-59/5 * * * *'),
      ('run-folder-summaries',         '2-59/5 * * * *'),
      ('check-folder-write-alerts-5m', '3-59/5 * * * *'),
      ('check-folder-retry-alerts-5m', '4-59/5 * * * *'),
      ('gmail-rescue-classify-10m',    '6-59/10 * * * *'),
      ('cron-watchdog',                '8-59/10 * * * *'),
      ('google-contacts-sync-15m',     '7-59/15 * * * *'),
      ('contact-enrich-enqueue-15m',   '13-59/15 * * * *'),
      ('gmail-renew-watches',          '9-59/30 * * * *'),
      ('relearn-folders-hourly',       '22 * * * *')
    ) AS t(jobname, schedule)
  LOOP
    SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = rec.jobname;
    IF v_jobid IS NOT NULL THEN
      PERFORM cron.alter_job(job_id := v_jobid, schedule := rec.schedule);
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  PERFORM cron.unschedule('gmail-poll');
EXCEPTION WHEN OTHERS THEN NULL; END $$;