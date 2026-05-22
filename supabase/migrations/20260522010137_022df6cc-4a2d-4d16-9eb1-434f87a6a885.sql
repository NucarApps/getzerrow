
-- Indexes that drive the worker's hot path
CREATE INDEX IF NOT EXISTS idx_message_jobs_picker
  ON public.message_jobs (priority, next_run_at)
  WHERE status <> 'dlq';

CREATE INDEX IF NOT EXISTS idx_message_jobs_stuck
  ON public.message_jobs (status, locked_at)
  WHERE status = 'running';

-- Atomically claim pending jobs in a single round-trip using
-- SELECT ... FOR UPDATE SKIP LOCKED so parallel workers never collide.
CREATE OR REPLACE FUNCTION public.claim_message_jobs(
  p_limit int,
  p_priority int DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  gmail_account_id uuid,
  gmail_message_id text,
  user_id uuid,
  attempt int,
  priority smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id
    FROM public.message_jobs j
    WHERE j.status <> 'dlq'
      AND j.next_run_at <= now()
      AND (j.locked_at IS NULL OR j.locked_at < now() - interval '5 minutes')
      AND (p_priority IS NULL OR j.priority = p_priority)
    ORDER BY j.priority ASC, j.next_run_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.message_jobs j
     SET status = 'running',
         locked_at = now(),
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
   RETURNING j.id, j.gmail_account_id, j.gmail_message_id, j.user_id, j.attempt, j.priority;
END;
$$;
