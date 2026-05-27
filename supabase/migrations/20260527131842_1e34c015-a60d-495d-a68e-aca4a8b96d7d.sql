
CREATE TABLE public.folder_summary_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  error text,
  emails_count integer,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX folder_summary_jobs_pending_idx
  ON public.folder_summary_jobs (created_at)
  WHERE status = 'pending';

CREATE INDEX folder_summary_jobs_user_idx
  ON public.folder_summary_jobs (user_id, created_at DESC);

GRANT SELECT ON public.folder_summary_jobs TO authenticated;
GRANT ALL ON public.folder_summary_jobs TO service_role;

ALTER TABLE public.folder_summary_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own folder summary jobs"
  ON public.folder_summary_jobs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Claim one (or N) pending jobs with SKIP LOCKED. Returns claimed rows.
CREATE OR REPLACE FUNCTION public.claim_folder_summary_jobs(p_limit integer DEFAULT 1)
RETURNS TABLE(id uuid, schedule_id uuid, user_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id
      FROM public.folder_summary_jobs j
     WHERE j.status = 'pending'
        OR (j.status = 'running' AND j.locked_at < now() - interval '5 minutes')
     ORDER BY j.created_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.folder_summary_jobs j
     SET status = 'running',
         locked_at = now(),
         started_at = COALESCE(j.started_at, now()),
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
   RETURNING j.id, j.schedule_id, j.user_id;
END;
$$;
