
-- 1) Track OAuth health on gmail_accounts so dead accounts stop silently failing.
ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS needs_reconnect boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_oauth_error text,
  ADD COLUMN IF NOT EXISTS consecutive_silent_ticks integer NOT NULL DEFAULT 0;

-- Backfill: any account whose refresh token is missing already needs a reconnect.
UPDATE public.gmail_accounts
   SET needs_reconnect = true,
       last_oauth_error = COALESCE(last_oauth_error,
         'Refresh token missing — reconnect required to keep mail flowing.')
 WHERE refresh_token_enc IS NULL
   AND needs_reconnect = false;

-- 2) Give pg_net enough time to wait for gmail-poll / gmail-reconcile, and log
--    every cron tick into pubsub_events so a silent endpoint never goes
--    unnoticed again. Default pg_net timeout is 5s — both endpoints routinely
--    exceed that with multi-account sync, so the request was being abandoned
--    before the endpoint could insert its own row.
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
    timeout_milliseconds := 60000   -- was implicit 5s — too short for poll/reconcile
  ) INTO v_req_id;

  -- Trace every dispatch so a silent endpoint or 401 surfaces in the
  -- Settings activity panel even when the endpoint itself fails to log.
  INSERT INTO public.pubsub_events (event_type, details)
  VALUES ('cron_post', path || ' (req=' || v_req_id || ')');

  RETURN v_req_id;
END;
$function$;

-- 3) Tighten watch-renewal cadence so a single missed cron tick can't lapse a
--    7-day watch. The endpoint is cheap when nothing is due (read-only query
--    against gmail_accounts), so running every 30 min costs effectively zero.
DO $$ BEGIN
  PERFORM cron.unschedule('gmail-renew-watches');
  PERFORM cron.unschedule('gmail-renew-watches-daily');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'gmail-renew-watches', '*/30 * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-renew-watches'); $$
);

-- 4) Periodic cron-silence watchdog. Inserts a `cron_silent` event whenever an
--    endpoint we expect to run frequently hasn't logged a successful row in N
--    minutes. Surfaced in AccountHealthCard so the user sees "polling stalled"
--    instead of a quietly-broken inbox.
CREATE OR REPLACE FUNCTION private.cron_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  rec record;
BEGIN
  FOR rec IN (
    SELECT *
    FROM (VALUES
      ('poll',                  10),  -- runs every 2 min, alert if 10 min silent
      ('reconcile',             60),  -- runs every 15 min, alert if 60 min silent
      ('watch_renew',          180)   -- runs every 30 min, alert if 3h silent
    ) AS t(kind, threshold_min)
  ) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.pubsub_events
       WHERE event_type = rec.kind
         AND error IS NULL
         AND received_at > now() - make_interval(mins => rec.threshold_min)
    ) THEN
      INSERT INTO public.pubsub_events (event_type, details, error)
      VALUES (
        'cron_silent',
        rec.kind || ' has not logged a successful run in ' || rec.threshold_min || ' min',
        'cron_silent:' || rec.kind
      );
    END IF;
  END LOOP;
END;
$$;

DO $$ BEGIN PERFORM cron.unschedule('cron-watchdog'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule('cron-watchdog', '*/10 * * * *', $$ SELECT private.cron_watchdog(); $$);
