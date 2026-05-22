
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS forward_to text,
  ADD COLUMN IF NOT EXISTS min_ai_confidence real NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS snooze_hours integer NOT NULL DEFAULT 0;

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS cc text,
  ADD COLUMN IF NOT EXISTS list_id text,
  ADD COLUMN IF NOT EXISTS in_reply_to text,
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS forwarded_to text,
  ADD COLUMN IF NOT EXISTS forwarded_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_emails_snoozed_until ON public.emails(snoozed_until) WHERE snoozed_until IS NOT NULL;
