
-- Durable per-message processing queue
CREATE TABLE IF NOT EXISTS public.message_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_account_id uuid NOT NULL,
  gmail_message_id text NOT NULL,
  user_id uuid NOT NULL,
  attempt integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending', -- pending | running | dlq
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  from_addr text,
  subject text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS message_jobs_account_message_unique
  ON public.message_jobs (gmail_account_id, gmail_message_id);

CREATE INDEX IF NOT EXISTS message_jobs_due_idx
  ON public.message_jobs (status, next_run_at)
  WHERE status <> 'dlq';

CREATE INDEX IF NOT EXISTS message_jobs_user_status_idx
  ON public.message_jobs (user_id, status);

ALTER TABLE public.message_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own message jobs"
  ON public.message_jobs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users update own message jobs"
  ON public.message_jobs FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own message jobs"
  ON public.message_jobs FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE TRIGGER message_jobs_set_updated_at
  BEFORE UPDATE ON public.message_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Ensure idempotent upserts on emails table (already de-facto unique)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='emails_account_message_unique'
  ) THEN
    CREATE UNIQUE INDEX emails_account_message_unique
      ON public.emails (gmail_account_id, gmail_message_id);
  END IF;
END $$;
