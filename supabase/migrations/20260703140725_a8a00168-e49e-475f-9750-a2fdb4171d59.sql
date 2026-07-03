-- Durable record of folder-example writes that needed a retry (attempt > 1).
-- Only retried writes are recorded (retries are rare), which keeps this small
-- while giving a clean signal for "instability before learning fully stops".
CREATE TABLE public.folder_write_retries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  gmail_account_id uuid,
  folder_id uuid,
  correlation_id uuid,
  source text,
  attempts integer NOT NULL,
  outcome text NOT NULL,
  error_code text
);
CREATE INDEX idx_fwr_occurred ON public.folder_write_retries (occurred_at DESC);
CREATE INDEX idx_fwr_group ON public.folder_write_retries (folder_id, occurred_at DESC);

-- Record of retry-rate alerts already fired, for cooldown de-duplication
-- (page once per incident per folder instead of on every tick).
CREATE TABLE public.folder_retry_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fired_at timestamptz NOT NULL DEFAULT now(),
  folder_id uuid,
  retry_count integer NOT NULL,
  window_minutes integer NOT NULL
);
CREATE INDEX idx_fra_group_fired ON public.folder_retry_alerts (folder_id, fired_at DESC);

-- Ops-only tables: written and read exclusively by service_role (cron
-- endpoints + admin server fns via supabaseAdmin). RLS enabled with no
-- policies so anon / authenticated clients have no access; service_role
-- bypasses RLS.
GRANT ALL ON public.folder_write_retries TO service_role;
GRANT ALL ON public.folder_retry_alerts  TO service_role;
ALTER TABLE public.folder_write_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_retry_alerts  ENABLE ROW LEVEL SECURITY;

-- Schedule the retry-rate evaluator every 5 minutes.
DO $$ BEGIN PERFORM cron.unschedule('check-folder-retry-alerts-5m'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'check-folder-retry-alerts-5m',
  '*/5 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/check-folder-retry-alerts'); $$
);