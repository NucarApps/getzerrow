-- Classification rescue infrastructure.
--
-- Why
--   Emails whose classification fails (AI gateway outage, worker killed
--   mid-job, queue retries exhausted) used to sit in the Inbox as
--   classified_by='unclassified' forever — nothing ever re-attempted
--   them. A new rescue sweep (/api/public/gmail-rescue-classify, every
--   10 min) re-runs rules + batched AI over recently-arrived stranded
--   rows. This migration provides its schema + schedule.
--
-- Pieces
--   1. emails.classify_attempts — per-email cap so the sweep can't
--      burn AI tokens on the same hopeless email forever.
--   2. Partial index matching the sweep predicate (cheap scans).
--   3. emails_decrypted view recreated with the new column appended
--      (the view is column-listed; CREATE OR REPLACE VIEW allows
--      appending columns at the end).
--   4. increment_emails_since_learn() — atomic counter used by
--      bumpEmailsSinceLearn (read-then-write lost counts under
--      concurrent workers).
--   5. pg_cron schedule for the sweep.
--
-- Operator action: none.

-- ─── 1. Attempt counter ──────────────────────────────────────────────────
ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS classify_attempts smallint NOT NULL DEFAULT 0;

-- ─── 2. Sweep index ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS emails_rescue_idx
  ON public.emails (created_at DESC)
  WHERE folder_id IS NULL
    AND classified_by IN ('pending', 'pending_ai', 'unclassified', 'ai_error');

-- ─── 3. emails_decrypted + classify_attempts ─────────────────────────────
-- Same definition as 20260525220000 with classify_attempts appended.
CREATE OR REPLACE VIEW public.emails_decrypted
WITH (security_invoker = true)
AS
SELECT
  e.id, e.user_id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
  e.from_addr, e.from_name, e.to_addrs, e.cc, e.list_id, e.in_reply_to,
  e.subject, e.snippet,
  COALESCE(private.decrypt_email_body(e.body_text_encrypted), NULLIF(e.body_text, ''))::text  AS body_text,
  COALESCE(private.decrypt_email_body(e.body_html_encrypted), NULLIF(e.body_html, ''))::text  AS body_html,
  e.received_at, e.is_read, e.is_archived, e.has_attachment, e.raw_labels,
  e.folder_id, e.classified_by, e.classification_reason,
  e.ai_summary, e.ai_confidence, e.matched_filter_ids, e.matched_folder_ids,
  e.snoozed_until, e.forwarded_to, e.forwarded_at,
  e.forward_attempts, e.forward_last_error, e.forward_next_retry_at, e.forward_locked_at,
  e.processed_at, e.published_at_ms, e.created_at, e.updated_at,
  e.classify_attempts
FROM public.emails e;

GRANT SELECT ON public.emails_decrypted TO authenticated, service_role;

-- ─── 4. Atomic learn counter ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.increment_emails_since_learn(p_folder_id uuid)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  UPDATE public.folders
     SET emails_since_learn = COALESCE(emails_since_learn, 0) + 1
   WHERE id = p_folder_id;
$$;
REVOKE ALL ON FUNCTION public.increment_emails_since_learn(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_emails_since_learn(uuid) TO service_role;

-- ─── 5. Rescue sweep schedule ────────────────────────────────────────────
-- Unschedule first so re-running this migration replaces the job.
DO $$
BEGIN
  PERFORM cron.unschedule('gmail-rescue-classify-10m');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'gmail-rescue-classify-10m',
  '*/10 * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-rescue-classify?limit=50'); $$
);

-- Operator tag.
INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'classification rescue sweep scheduled (every 10 min)');
