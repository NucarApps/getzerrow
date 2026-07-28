-- Zerrow: cron stampede + Google Contacts push backoff
-- Consolidated from supabase/migrations/2026072812{0000,0100,0200,0300}_*.sql
-- Safe to re-run: every statement is guarded or IF NOT EXISTS.

-- ============================================================
-- 20260728120000_google_contact_links_push_backoff
-- ============================================================
-- Body-push failure budget for Google Contacts.
--
-- Before this, a contact whose People API write kept failing (the live case:
-- 429 RESOURCE_EXHAUSTED / "FBS quota limit exceeded") stayed dirty forever —
-- `last_synced_at` only advances on success, so every sync run re-attempted the
-- same doomed write and burned account-wide contact-write quota that healthy
-- contacts needed. The photo lane already had `photo_push_attempts`; the body
-- lane had nothing.
--
-- Backoff rather than a hard give-up: the quota does reset, so the contact must
-- eventually come back. See PUSH_BACKOFF_BASE_MS / PUSH_BACKOFF_MAX_MS in
-- src/lib/google-contacts/dirty.ts (5 min doubling to a 6 h ceiling).
ALTER TABLE public.google_contact_links
  ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS push_backoff_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_push_error text,
  ADD COLUMN IF NOT EXISTS last_push_error_at timestamptz;

-- Selection reads "which links are cooling off" on every push run.
CREATE INDEX IF NOT EXISTS google_contact_links_push_backoff_idx
  ON public.google_contact_links (gmail_account_id, push_backoff_until)
  WHERE push_backoff_until IS NOT NULL;

INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'google_contact_links: push_attempts/push_backoff_until added (429 retry storm fix)');

-- ============================================================
-- 20260728120100_drop_encryption_backfill_cron
-- ============================================================
-- Retire the encryption-backfill cron.
--
-- The four RPCs it drives (backfill_emails_encryption, backfill_contacts_
-- encryption, backfill_reply_drafts_encryption, backfill_folder_examples_
-- encryption) were dropped in 20260528105923 once the at-rest encryption
-- rollout finished. The cron kept firing nightly and logging four PGRST202
-- "Could not find the function ... in the schema cache" errors into
-- pubsub_events, which feeds the account-health UI — pure noise that
-- desensitizes a real signal.
--
-- The job was scheduled outside migrations (Supabase dashboard), so unschedule
-- it by command match rather than by a name we can only guess at. The matching
-- route handler is deleted in the same change.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT jobname FROM cron.job WHERE command ILIKE '%encryption-backfill%'
  LOOP
    PERFORM cron.unschedule(rec.jobname);
    INSERT INTO public.pubsub_events (event_type, details)
    VALUES ('migration', 'unscheduled dead cron job: ' || rec.jobname);
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- Never block the migration on cron introspection permissions.
  INSERT INTO public.pubsub_events (event_type, details, error)
  VALUES ('migration', 'encryption-backfill unschedule skipped', SQLERRM);
END $$;

-- ============================================================
-- 20260728120200_stagger_cron_schedules
-- ============================================================
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

-- ============================================================
-- 20260728120300_cron_dispatch_reaper
-- ============================================================
-- Make a dropped cron tick visible.
--
-- private.cron_post fires pg_net and never looks at the response, so when
-- Cloudflare answers a dispatch with 502 ("Too many dynamic workers") that tick
-- is simply lost: no retry, no error row, nothing in the health panel. The
-- stagger in 20260728120200 removes most of the collisions that caused those
-- 502s, but the blind spot itself is what let them run unnoticed for weeks.
--
-- This records every dispatch, then reaps the pg_net response a minute later
-- and logs anything that did not come back 2xx. Logging only — no auto-retry,
-- since re-firing an endpoint that may have partially run is a bigger change
-- than the visibility problem warrants.

CREATE TABLE IF NOT EXISTS private.cron_dispatch (
  req_id        bigint PRIMARY KEY,
  path          text NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  checked_at    timestamptz
);

-- The reaper only ever scans the unchecked tail.
CREATE INDEX IF NOT EXISTS cron_dispatch_unchecked_idx
  ON private.cron_dispatch (dispatched_at)
  WHERE checked_at IS NULL;

-- cron_post gains one insert; everything else is unchanged from 20260526145044.
CREATE OR REPLACE FUNCTION private.cron_post(path text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'private', 'public'
AS $function$
DECLARE
  v_apikey text;
  v_secret text;
  v_base   text;
  v_headers jsonb;
  v_req_id bigint;
BEGIN
  SELECT value INTO v_apikey FROM private.cron_settings WHERE name = 'apikey';
  SELECT value INTO v_secret FROM private.cron_settings WHERE name = 'cron_secret';
  SELECT value INTO v_base   FROM private.cron_settings WHERE name = 'base_url';

  IF v_base IS NULL THEN
    INSERT INTO public.pubsub_events (event_type, details, error)
    VALUES ('cron_post', path, 'cron_post: missing base_url');
    RETURN NULL;
  END IF;

  v_headers := jsonb_build_object('Content-Type', 'application/json');
  IF v_apikey IS NOT NULL THEN
    v_headers := v_headers || jsonb_build_object('apikey', v_apikey);
  END IF;
  IF v_secret IS NOT NULL THEN
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || v_secret);
  END IF;

  IF v_apikey IS NULL AND v_secret IS NULL THEN
    INSERT INTO public.pubsub_events (event_type, details, error)
    VALUES ('cron_post', path, 'cron_post: no auth available');
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_base || path,
    headers := v_headers,
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req_id;

  -- Trace every dispatch so a silent endpoint or 401 surfaces in the
  -- Settings activity panel even when the endpoint itself fails to log.
  INSERT INTO public.pubsub_events (event_type, details)
  VALUES ('cron_post', path || ' (req=' || v_req_id || ')');

  -- ...and hand the request id to the reaper, which checks how it landed.
  INSERT INTO private.cron_dispatch (req_id, path)
  VALUES (v_req_id, path)
  ON CONFLICT (req_id) DO NOTHING;

  RETURN v_req_id;
END;
$function$;

CREATE OR REPLACE FUNCTION private.cron_dispatch_reap()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'private', 'public', 'net'
AS $$
DECLARE
  rec record;
BEGIN
  -- 90 s of grace: cron_post's own pg_net timeout is 60 s, so anything with no
  -- response row by now genuinely never landed.
  FOR rec IN
    SELECT d.req_id,
           d.path,
           r.status_code,
           r.error_msg,
           r.timed_out
      FROM private.cron_dispatch d
      LEFT JOIN net._http_response r ON r.id = d.req_id
     WHERE d.checked_at IS NULL
       AND d.dispatched_at < now() - interval '90 seconds'
     ORDER BY d.dispatched_at
     LIMIT 500
  LOOP
    IF rec.status_code IS NULL OR rec.status_code >= 400 THEN
      INSERT INTO public.pubsub_events (event_type, details, error)
      VALUES (
        'cron_post_failed',
        rec.path || ' (req=' || rec.req_id || ')',
        COALESCE(
          'status=' || rec.status_code::text,
          CASE WHEN rec.timed_out THEN 'timed out' ELSE NULL END,
          rec.error_msg,
          'no response recorded'
        )
      );
    END IF;

    UPDATE private.cron_dispatch SET checked_at = now() WHERE req_id = rec.req_id;
  END LOOP;

  -- pg_net drops its own response rows on a TTL; keep this table bounded too.
  DELETE FROM private.cron_dispatch WHERE dispatched_at < now() - interval '2 days';
END;
$$;

REVOKE ALL ON FUNCTION private.cron_dispatch_reap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE private.cron_dispatch FROM PUBLIC, anon, authenticated;

-- Offset minutes (5,15,25,...) — clear of both the :00 boundary and the
-- every-5-minute group's 1/2/3/4 offsets set in 20260728120200.
DO $$ BEGIN
  PERFORM cron.unschedule('cron-dispatch-reap');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'cron-dispatch-reap',
  '5-59/10 * * * *',
  $$ SELECT private.cron_dispatch_reap(); $$
);

INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'cron dispatch reaper scheduled — non-2xx cron ticks now log cron_post_failed');

