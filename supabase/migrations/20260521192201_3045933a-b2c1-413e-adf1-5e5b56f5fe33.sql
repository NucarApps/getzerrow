-- Seed the publishable key into private.cron_settings so the helper can attach
-- it as the `apikey` header on scheduled HTTP calls. The publishable key is
-- public-safe.
INSERT INTO private.cron_settings (name, value)
VALUES (
  'apikey',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF4aWxjaW5sbmF1anh5a3NmamluIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDUwMDYsImV4cCI6MjA5NDc4MTAwNn0.G_LCsns9WKBptWkWdjDzDx7jzcXGBK0R8Pa_ESs7sZ4'
)
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

-- Make sure base_url points at the stable production URL.
INSERT INTO private.cron_settings (name, value)
VALUES ('base_url', 'https://getzerrow.lovable.app')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

-- Replace the helper: prefer apikey header (always seeded above); fall back to
-- bearer token only if a cron_secret happens to be present.
CREATE OR REPLACE FUNCTION private.cron_post(path text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public
AS $$
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
    RAISE NOTICE 'cron_post: missing base_url';
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
    RAISE NOTICE 'cron_post: no auth available (apikey + cron_secret both missing)';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_base || path,
    headers := v_headers,
    body    := '{}'::jsonb
  ) INTO v_req_id;
  RETURN v_req_id;
END;
$$;

-- Kick the queue right now so the existing backlog doesn't have to wait for
-- the next scheduled tick. Safe / idempotent.
SELECT private.cron_post('/api/public/gmail-process-jobs');
SELECT private.cron_post('/api/public/gmail-poll');
