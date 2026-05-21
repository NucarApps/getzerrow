ALTER TABLE public.message_jobs ADD COLUMN IF NOT EXISTS priority smallint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_message_jobs_claim
  ON public.message_jobs (status, priority, next_run_at)
  WHERE status <> 'dlq';