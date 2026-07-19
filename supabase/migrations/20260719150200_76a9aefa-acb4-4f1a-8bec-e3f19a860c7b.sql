-- Background AI contact enrichment: job queue (bios + group-suggestion
-- runs), claim RPC, suggestion confidence columns, and the pg_cron
-- schedules that drive the worker hooks. Mirrors the folder-summary queue
-- (20260527131842 / 20260527131901).

CREATE TABLE public.contact_enrich_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('bio', 'suggest')),
  -- bio jobs target one contact; suggest jobs scan the whole user.
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  CONSTRAINT contact_enrich_jobs_contact_required
    CHECK (kind = 'suggest' OR contact_id IS NOT NULL),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contact_enrich_jobs_pending_idx
  ON public.contact_enrich_jobs (created_at)
  WHERE status = 'pending';

CREATE INDEX contact_enrich_jobs_user_idx
  ON public.contact_enrich_jobs (user_id, created_at DESC);

-- Idempotent enqueue: one live job per (user, kind, contact).
CREATE UNIQUE INDEX contact_enrich_jobs_live_uniq
  ON public.contact_enrich_jobs (user_id, kind, COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('pending', 'running');

GRANT SELECT ON public.contact_enrich_jobs TO authenticated;
GRANT ALL ON public.contact_enrich_jobs TO service_role;

ALTER TABLE public.contact_enrich_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own contact enrich jobs"
  ON public.contact_enrich_jobs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Claim N jobs with SKIP LOCKED; running jobs whose 5-minute lease expired
-- are reclaimable (worker died mid-job).
CREATE OR REPLACE FUNCTION public.claim_contact_enrich_jobs(p_limit integer DEFAULT 1)
RETURNS TABLE(id uuid, user_id uuid, kind text, contact_id uuid, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id
      FROM public.contact_enrich_jobs j
     WHERE j.status = 'pending'
        OR (j.status = 'running' AND j.locked_at < now() - interval '5 minutes')
     ORDER BY j.created_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.contact_enrich_jobs j
     SET status = 'running',
         locked_at = now(),
         attempts = j.attempts + 1,
         started_at = COALESCE(j.started_at, now()),
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
   RETURNING j.id, j.user_id, j.kind, j.contact_id, j.attempts;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_contact_enrich_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contact_enrich_jobs(integer) TO service_role;

-- Suggestion confidence: AI self-assessment (veto only) + the deterministic
-- evidence recorded when the background gate auto-applies.
ALTER TABLE public.contact_group_suggestions
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS evidence jsonb,
  ADD COLUMN IF NOT EXISTS auto_applied boolean NOT NULL DEFAULT false;

-- Schedules: enqueue pass every 15 minutes, worker tick every 2 minutes.
DO $$ BEGIN
  PERFORM cron.unschedule('contact-enrich-enqueue-15m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'contact-enrich-enqueue-15m',
  '*/15 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/enqueue-contact-enrichment'); $$
);

DO $$ BEGIN
  PERFORM cron.unschedule('contact-enrich-jobs-2m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'contact-enrich-jobs-2m',
  '*/2 * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/run-contact-enrich-jobs'); $$
);
