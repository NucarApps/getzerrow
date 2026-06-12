ALTER TABLE public.gmail_accounts ADD COLUMN IF NOT EXISTS last_push_at TIMESTAMPTZ;
ALTER TABLE public.message_jobs ADD COLUMN IF NOT EXISTS published_at_ms BIGINT;
ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS forward_locked_at TIMESTAMPTZ;
DROP INDEX IF EXISTS public.emails_forward_retry_idx;
CREATE INDEX IF NOT EXISTS emails_forward_retry_idx ON public.emails (forward_next_retry_at) WHERE forward_next_retry_at IS NOT NULL;