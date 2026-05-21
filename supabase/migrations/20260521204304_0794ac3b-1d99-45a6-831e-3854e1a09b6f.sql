
CREATE TABLE public.backfill_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gmail_account_id uuid NOT NULL,
  query text NOT NULL,
  months integer NOT NULL DEFAULT 6,
  status text NOT NULL DEFAULT 'listing',
  next_page_token text,
  total_found integer NOT NULL DEFAULT 0,
  total_enqueued integer NOT NULL DEFAULT 0,
  already_had integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

ALTER TABLE public.backfill_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own backfill jobs"
  ON public.backfill_jobs FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_backfill_jobs_active
  ON public.backfill_jobs (gmail_account_id, status)
  WHERE status IN ('listing', 'processing');

CREATE INDEX idx_backfill_jobs_pick
  ON public.backfill_jobs (updated_at)
  WHERE status IN ('listing', 'processing');

CREATE TRIGGER set_backfill_jobs_updated_at
  BEFORE UPDATE ON public.backfill_jobs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
