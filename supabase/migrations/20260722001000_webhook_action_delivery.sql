-- Webhook action delivery (rules upgrade, task 5): include_body opt-in,
-- encrypted webhook-secret read/write RPCs, the SKIP LOCKED claim RPC for
-- the scheduled_actions queue, and the runner cron.
--
-- Webhook secrets are encrypted at rest (webhook_secret_enc, task 4
-- schema) with EMAIL_ENC_KEY via private.encrypt_text — the setter and
-- the decrypting getter below are the ONLY paths that touch the column,
-- both service-role-only.

-- Payloads exclude email bodies unless the action explicitly opts in.
ALTER TABLE public.folder_actions
  ADD COLUMN IF NOT EXISTS include_body boolean NOT NULL DEFAULT false;

-- Store a webhook config with the secret encrypted. Ownership is checked
-- against p_user_id (the caller passes the authenticated user id).
CREATE OR REPLACE FUNCTION public.set_folder_action_webhook(
  p_action_id uuid,
  p_user_id uuid,
  p_url text,
  p_secret text,
  p_key text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.folder_actions
     SET webhook_url = p_url,
         webhook_secret_enc = private.encrypt_text(p_secret, p_key)
   WHERE id = p_action_id
     AND user_id = p_user_id
     AND action_type = 'call_webhook';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_folder_action_webhook(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_folder_action_webhook(uuid, uuid, text, text, text) TO service_role;

-- Decrypt a webhook config for delivery (server-side runner only).
CREATE OR REPLACE FUNCTION public.get_folder_action_webhook(
  p_action_id uuid,
  p_key text
)
RETURNS TABLE(webhook_url text, webhook_secret text, include_body boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $$
  SELECT
    fa.webhook_url,
    private.decrypt_text(fa.webhook_secret_enc, p_key),
    fa.include_body
  FROM public.folder_actions fa
  WHERE fa.id = p_action_id;
$$;

REVOKE EXECUTE ON FUNCTION public.get_folder_action_webhook(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_folder_action_webhook(uuid, text) TO service_role;

-- Claim due scheduled actions with SKIP LOCKED; 'running' rows whose
-- 5-minute lease expired are reclaimable (worker died mid-job). The
-- attempt counter increments on claim.
CREATE OR REPLACE FUNCTION public.claim_scheduled_actions(p_limit integer DEFAULT 20)
RETURNS TABLE(id uuid, user_id uuid, folder_action_id uuid, email_id uuid, attempt integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT s.id
      FROM public.scheduled_actions s
     WHERE (s.status = 'pending' AND s.run_at <= now())
        OR (s.status = 'running' AND s.claimed_at < now() - interval '5 minutes')
     ORDER BY s.run_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.scheduled_actions s
     SET status = 'running',
         claimed_at = now(),
         attempt = s.attempt + 1
    FROM picked
   WHERE s.id = picked.id
   RETURNING s.id, s.user_id, s.folder_action_id, s.email_id, s.attempt;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_scheduled_actions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_scheduled_actions(integer) TO service_role;

-- Runner tick: every minute.
DO $$ BEGIN
  PERFORM cron.unschedule('run-scheduled-actions-1m');
EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'run-scheduled-actions-1m',
  '* * * * *',
  $$ SELECT private.cron_post('/api/public/hooks/run-scheduled-actions'); $$
);
