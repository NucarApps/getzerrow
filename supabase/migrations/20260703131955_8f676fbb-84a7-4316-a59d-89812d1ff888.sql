-- Durable log of folder_example_write failures (metadata only, no email content)
-- so the alert cron can aggregate spikes by error_code + folder_id over a
-- time window. Populated best-effort by insertFolderExampleEncrypted.
CREATE TABLE public.folder_write_failures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  gmail_account_id uuid,
  folder_id uuid,
  error_code text,
  source text
);
CREATE INDEX idx_fwf_occurred ON public.folder_write_failures (occurred_at DESC);
CREATE INDEX idx_fwf_group ON public.folder_write_failures (error_code, folder_id, occurred_at DESC);

-- Record of alerts already fired, for cooldown de-duplication (page once per
-- incident per group instead of on every tick).
CREATE TABLE public.folder_write_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fired_at timestamptz NOT NULL DEFAULT now(),
  error_code text NOT NULL,
  folder_id uuid,
  failure_count integer NOT NULL,
  window_minutes integer NOT NULL
);
CREATE INDEX idx_fwa_group_fired ON public.folder_write_alerts (error_code, folder_id, fired_at DESC);

-- Ops-only tables: written and read exclusively by service_role (the cron
-- endpoints via supabaseAdmin). RLS is enabled with no policies so anon /
-- authenticated clients have no access; service_role bypasses RLS.
GRANT ALL ON public.folder_write_failures TO service_role;
GRANT ALL ON public.folder_write_alerts   TO service_role;
ALTER TABLE public.folder_write_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_write_alerts   ENABLE ROW LEVEL SECURITY;

-- Schedule the alert evaluator every 5 minutes.
DO $$ BEGIN PERFORM cron.unschedule('check-folder-write-alerts-5m'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'check-folder-write-alerts-5m',
  '*/5 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/check-folder-write-alerts'); $$
);