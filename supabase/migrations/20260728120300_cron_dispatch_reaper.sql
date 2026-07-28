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
