-- Stagger cron phases so the fleet stops stampeding the Worker at :00.
--
-- Every recurring job was phase-aligned to minute 0 (`*/2`, `*/5`, `*/10`,
-- `*/15`, `*/30` all fire together at the top of the hour, plus the four
-- every-minute jobs). Cloudflare answers the pile-up with 502s:
--   "Too many dynamic workers." / "Too many dynamic workers are starting
--    concurrently."
-- Every observed 502 in the logs is at an exact :00:00 boundary. cron_post is
-- fire-and-forget over pg_net, so a rejected tick is simply lost — nothing
-- retries it.
--
-- Same cadences, different offsets. `N-59/M` = every M minutes starting at
-- minute N, so the per-hour run count is unchanged.
DO $$
DECLARE
  rec record;
  v_jobid bigint;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      -- every 2 min: keep poll on even minutes, push the other two to odd
      ('gmail-poll-2m',                '*/2 * * * *'),
      ('contact-enrich-jobs-2m',       '1-59/2 * * * *'),
      ('schedule-meeting-bots-2m',     '1-59/2 * * * *'),
      -- every 5 min: one per offset, none on the :00 boundary
      ('gmail-reconcile-5m',           '1-59/5 * * * *'),
      ('run-folder-summaries',         '2-59/5 * * * *'),
      ('check-folder-write-alerts-5m', '3-59/5 * * * *'),
      ('check-folder-retry-alerts-5m', '4-59/5 * * * *'),
      -- every 10 / 15 / 30 min
      ('gmail-rescue-classify-10m',    '6-59/10 * * * *'),
      ('cron-watchdog',                '8-59/10 * * * *'),
      ('google-contacts-sync-15m',     '7-59/15 * * * *'),
      ('contact-enrich-enqueue-15m',   '13-59/15 * * * *'),
      ('gmail-renew-watches',          '9-59/30 * * * *'),
      -- hourly: relearn-folders and send-digest both sat on minute 7
      ('relearn-folders-hourly',       '22 * * * *')
    ) AS t(jobname, schedule)
  LOOP
    SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = rec.jobname;
    IF v_jobid IS NOT NULL THEN
      PERFORM cron.alter_job(job_id := v_jobid, schedule := rec.schedule);
    END IF;
  END LOOP;
END $$;

-- Duplicate poller: 'gmail-poll' (20260521010254) and 'gmail-poll-2m'
-- (20260629200036) both POST /api/public/gmail-poll every 2 minutes — the
-- rename never unscheduled the original, so the endpoint has been called twice
-- per tick ever since. Keep the current name, drop the legacy one.
DO $$ BEGIN
  PERFORM cron.unschedule('gmail-poll');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'cron schedules staggered off the :00 boundary; duplicate gmail-poll job removed');
