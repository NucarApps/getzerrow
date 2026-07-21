-- Recreate contact_enrich_jobs (previous migration recorded but table missing) with expanded kinds
CREATE TABLE IF NOT EXISTS public.contact_enrich_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
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

ALTER TABLE public.contact_enrich_jobs
  DROP CONSTRAINT IF EXISTS contact_enrich_jobs_kind_check;
ALTER TABLE public.contact_enrich_jobs
  ADD CONSTRAINT contact_enrich_jobs_kind_check
    CHECK (kind IN ('bio', 'suggest', 'dedup_scan', 'signature_scan'));

ALTER TABLE public.contact_enrich_jobs
  DROP CONSTRAINT IF EXISTS contact_enrich_jobs_contact_required;
ALTER TABLE public.contact_enrich_jobs
  ADD CONSTRAINT contact_enrich_jobs_contact_required
    CHECK (kind IN ('suggest', 'dedup_scan', 'signature_scan') OR contact_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS contact_enrich_jobs_pending_idx
  ON public.contact_enrich_jobs (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS contact_enrich_jobs_user_idx
  ON public.contact_enrich_jobs (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS contact_enrich_jobs_live_uniq
  ON public.contact_enrich_jobs (user_id, kind, COALESCE(contact_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('pending', 'running');

GRANT SELECT ON public.contact_enrich_jobs TO authenticated;
GRANT ALL ON public.contact_enrich_jobs TO service_role;

ALTER TABLE public.contact_enrich_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own contact enrich jobs" ON public.contact_enrich_jobs;
CREATE POLICY "Users view own contact enrich jobs"
  ON public.contact_enrich_jobs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

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

ALTER TABLE public.contact_group_suggestions
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'low'
    CHECK (confidence IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS evidence jsonb,
  ADD COLUMN IF NOT EXISTS auto_applied boolean NOT NULL DEFAULT false;

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

-- CardDAV tombstone trigger for CONTACT deletions
CREATE OR REPLACE FUNCTION public.record_carddav_contact_tombstone()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.carddav_tombstones (user_id, resource_type, resource_id)
  VALUES (OLD.user_id, 'contact', OLD.id)
  ON CONFLICT (user_id, resource_type, resource_id)
  DO UPDATE SET deleted_at = now();
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS record_carddav_contact_tombstone_trigger ON public.contacts;
CREATE TRIGGER record_carddav_contact_tombstone_trigger
  BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.record_carddav_contact_tombstone();