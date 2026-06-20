-- Classification rescue infrastructure, adapted to the live v2 encrypted
-- schema. The original repo migration (20260612000000) targeted an older
-- design (emails_decrypted view + plaintext body_text columns) that was
-- never applied to this database. Only the compatible pieces are kept here.

-- 1. Attempt counter ------------------------------------------------------
ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS classify_attempts smallint NOT NULL DEFAULT 0;

-- 2. Sweep index ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS emails_rescue_idx
  ON public.emails (created_at DESC)
  WHERE folder_id IS NULL
    AND classified_by IN ('pending', 'pending_ai', 'unclassified', 'ai_error');

-- 3. Atomic learn counter -------------------------------------------------
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

-- 4. Rescue sweep schedule -----------------------------------------------
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