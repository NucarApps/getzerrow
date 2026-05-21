-- Private schema + settings table for cron auth (service-role only)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.cron_settings (
  name  text PRIMARY KEY,
  value text NOT NULL
);
REVOKE ALL ON private.cron_settings FROM PUBLIC, anon, authenticated;
ALTER TABLE private.cron_settings ENABLE ROW LEVEL SECURITY;
-- No policies = no access via PostgREST; only service_role can read.

-- Seed base_url (published, stable URL). CRON_SECRET inserted separately.
INSERT INTO private.cron_settings (name, value)
VALUES ('base_url', 'https://getzerrow.lovable.app')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

-- Helper: build Authorization header from stored secret
CREATE OR REPLACE FUNCTION private.cron_post(path text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public
AS $$
DECLARE
  v_secret text;
  v_base   text;
  v_req_id bigint;
BEGIN
  SELECT value INTO v_secret FROM private.cron_settings WHERE name = 'cron_secret';
  SELECT value INTO v_base   FROM private.cron_settings WHERE name = 'base_url';
  IF v_secret IS NULL OR v_base IS NULL THEN
    RAISE NOTICE 'cron_post: missing cron_secret or base_url';
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url     := v_base || path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    body    := '{}'::jsonb
  ) INTO v_req_id;
  RETURN v_req_id;
END;
$$;

-- Unschedule any previous versions (idempotent)
DO $$
DECLARE j text;
BEGIN
  FOREACH j IN ARRAY ARRAY[
    'gmail-process-jobs',
    'gmail-poll',
    'gmail-renew-watches',
    'run-folder-summaries'
  ] LOOP
    BEGIN PERFORM cron.unschedule(j); EXCEPTION WHEN OTHERS THEN NULL; END;
  END LOOP;
END $$;

-- Schedule jobs
SELECT cron.schedule(
  'gmail-process-jobs', '* * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-process-jobs'); $$
);

SELECT cron.schedule(
  'gmail-poll', '*/2 * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-poll'); $$
);

SELECT cron.schedule(
  'gmail-renew-watches', '0 */6 * * *',
  $$ SELECT private.cron_post('/api/public/gmail-renew-watches'); $$
);

SELECT cron.schedule(
  'run-folder-summaries', '*/5 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/run-folder-summaries'); $$
);