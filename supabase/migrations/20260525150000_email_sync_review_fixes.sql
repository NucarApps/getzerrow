-- Follow-up to 20260525120000_email_sync_improvements that addresses review
-- findings:
--   * Silence detection (poll cron) was using last_history_sync_at, which the
--     poll itself ticks on every run, so it never fired. New column
--     last_push_at is stamped ONLY by the webhook handler.
--   * Forward retries had no atomic claim → concurrent crons could double-send.
--     forward_locked_at lets retryForwardAttempts use the "stamp + filter"
--     pattern that runMessageJobs uses.
--   * published_at_ms was held in a per-process Map and lost when the worker
--     that drains a job isn't the same process as the webhook that enqueued it.
--     Move it onto message_jobs so any worker can read it.

ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS last_push_at TIMESTAMPTZ;

ALTER TABLE public.message_jobs
  ADD COLUMN IF NOT EXISTS published_at_ms BIGINT;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS forward_locked_at TIMESTAMPTZ;

-- Replaces emails_forward_retry_idx — must also exclude rows that are
-- currently locked-and-recent so the next claim skips them.
DROP INDEX IF EXISTS public.emails_forward_retry_idx;
CREATE INDEX IF NOT EXISTS emails_forward_retry_idx
  ON public.emails (forward_next_retry_at)
  WHERE forward_next_retry_at IS NOT NULL;
