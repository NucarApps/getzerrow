-- Email sync improvements:
--   * gmail_accounts.reconcile_cursor: walks older messages across reconcile ticks
--   * gmail_accounts.last_history_sync_at: detects when a Pub/Sub push should have
--     triggered a sync but didn't (used by silence-detection logic).
--   * emails.published_at_ms: Pub/Sub publish time (ms since epoch), used for
--     end-to-end push→visible latency telemetry.
--   * emails.forward_attempts / forward_last_error / forward_next_retry_at:
--     auto-forward retry state so transient failures don't get swallowed.
--   * pubsub_events.latency_ms: end-to-end push→processed latency per push event.
--   * Index that lets the DLQ auto-replay cron find transient failures quickly.

ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS reconcile_cursor TIMESTAMPTZ;

ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS last_history_sync_at TIMESTAMPTZ;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS published_at_ms BIGINT;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS forward_attempts SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS forward_last_error TEXT;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS forward_next_retry_at TIMESTAMPTZ;

ALTER TABLE public.pubsub_events
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

-- Find DLQ jobs with transient-looking errors for auto-replay.
CREATE INDEX IF NOT EXISTS message_jobs_dlq_idx
  ON public.message_jobs (status, updated_at DESC)
  WHERE status = 'dlq';

-- Find emails that need a forward retry.
CREATE INDEX IF NOT EXISTS emails_forward_retry_idx
  ON public.emails (forward_next_retry_at)
  WHERE forward_next_retry_at IS NOT NULL;
