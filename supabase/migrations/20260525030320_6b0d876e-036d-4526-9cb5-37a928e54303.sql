ALTER TABLE public.gmail_accounts ADD COLUMN IF NOT EXISTS reconcile_cursor TIMESTAMPTZ;
ALTER TABLE public.gmail_accounts ADD COLUMN IF NOT EXISTS last_history_sync_at TIMESTAMPTZ;
ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS published_at_ms BIGINT;
ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS forward_attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS forward_last_error TEXT;
ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS forward_next_retry_at TIMESTAMPTZ;
ALTER TABLE public.pubsub_events ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
CREATE INDEX IF NOT EXISTS message_jobs_dlq_idx ON public.message_jobs (status, updated_at DESC) WHERE status = 'dlq';
CREATE INDEX IF NOT EXISTS emails_forward_retry_idx ON public.emails (forward_next_retry_at) WHERE forward_next_retry_at IS NOT NULL;