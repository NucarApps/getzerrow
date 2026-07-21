-- Rules-engine audit log (rules upgrade, task 1): one executed_rules row
-- per classification execution — the rules and AI branches of the classify
-- path both funnel through a single recordExecution call site in
-- process-message.ts. executed_actions is the child table the per-action
-- dispatcher (folder_actions, task 4) will write to; created here so the
-- audit schema lands as one unit.
--
-- Encryption: the classification reason can embed AI output about the
-- email, so it is stored encrypted (reason_enc) via private.encrypt_text
-- with the server-held EMAIL_ENC_KEY — mirroring
-- emails.classification_reason_enc. Inserts and decrypting reads therefore
-- go through service-role-only RPCs; RLS gives users read access to their
-- own rows (ciphertext only for the reason column).

CREATE TABLE public.executed_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gmail_account_id uuid NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  -- Cascade with the email: disconnecting a mailbox / deleting an account
  -- purges synced content, and the audit rows describe that content.
  email_id uuid REFERENCES public.emails(id) ON DELETE CASCADE,
  gmail_message_id text NOT NULL,
  folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  classified_by text NOT NULL,
  ai_confidence double precision,
  matched_filter_ids uuid[] NOT NULL DEFAULT '{}',
  -- Rule leaves (field/op/value) that fired — user rule config, not email
  -- content, so plain jsonb is fine.
  matched_leaf_json jsonb,
  reason_enc bytea,
  automated boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied', 'skipped', 'error', 'pending')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX executed_rules_user_created_idx
  ON public.executed_rules (user_id, created_at DESC);

CREATE INDEX executed_rules_folder_created_idx
  ON public.executed_rules (folder_id, created_at DESC);

CREATE INDEX executed_rules_email_idx
  ON public.executed_rules (email_id);

ALTER TABLE public.executed_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own executed rules"
  ON public.executed_rules FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

GRANT SELECT ON public.executed_rules TO authenticated;
GRANT ALL ON public.executed_rules TO service_role;

CREATE TABLE public.executed_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_rule_id uuid NOT NULL REFERENCES public.executed_rules(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('applied', 'skipped', 'error', 'pending')),
  error text,
  -- Action configuration only (label ids, forward address, …) — never
  -- email content or AI output. Actions that carry sensitive payloads
  -- (reply templates, task 8) must add encrypted columns instead.
  payload jsonb,
  ran_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX executed_actions_rule_idx
  ON public.executed_actions (executed_rule_id);

ALTER TABLE public.executed_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own executed actions"
  ON public.executed_actions FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.executed_rules er
     WHERE er.id = executed_rule_id
       AND er.user_id = auth.uid()
  ));

GRANT SELECT ON public.executed_actions TO authenticated;
GRANT ALL ON public.executed_actions TO service_role;

-- Insert RPC (service-role only): encrypts the reason at rest.
CREATE OR REPLACE FUNCTION public.record_executed_rule(
  p_user_id uuid,
  p_gmail_account_id uuid,
  p_email_id uuid,
  p_gmail_message_id text,
  p_folder_id uuid,
  p_classified_by text,
  p_ai_confidence double precision,
  p_matched_filter_ids uuid[],
  p_matched_leaf_json jsonb,
  p_reason text,
  p_automated boolean,
  p_status text,
  p_error text,
  p_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.executed_rules (
    user_id, gmail_account_id, email_id, gmail_message_id, folder_id,
    classified_by, ai_confidence, matched_filter_ids, matched_leaf_json,
    reason_enc, automated, status, error
  ) VALUES (
    p_user_id, p_gmail_account_id, p_email_id, p_gmail_message_id, p_folder_id,
    p_classified_by, p_ai_confidence, COALESCE(p_matched_filter_ids, '{}'::uuid[]),
    p_matched_leaf_json, private.encrypt_text(p_reason, p_key),
    COALESCE(p_automated, true), p_status, p_error
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_executed_rule(uuid, uuid, uuid, text, uuid, text, double precision, uuid[], jsonb, text, boolean, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_executed_rule(uuid, uuid, uuid, text, uuid, text, double precision, uuid[], jsonb, text, boolean, text, text, text) TO service_role;

-- Decrypting list RPC (service-role only). Callers are server functions
-- that pass the authenticated user's id — same pattern as
-- get_emails_list_decrypted.
CREATE OR REPLACE FUNCTION public.list_executed_rules(
  p_user_id uuid,
  p_account_id uuid,
  p_folder_id uuid,
  p_cursor timestamptz,
  p_limit integer,
  p_key text
)
RETURNS TABLE(
  id uuid,
  gmail_account_id uuid,
  email_id uuid,
  gmail_message_id text,
  folder_id uuid,
  folder_name text,
  classified_by text,
  ai_confidence double precision,
  matched_filter_ids uuid[],
  matched_leaf_json jsonb,
  reason text,
  automated boolean,
  status text,
  error text,
  created_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $$
  SELECT
    er.id,
    er.gmail_account_id,
    er.email_id,
    er.gmail_message_id,
    er.folder_id,
    f.name,
    er.classified_by,
    er.ai_confidence,
    er.matched_filter_ids,
    er.matched_leaf_json,
    private.decrypt_text(er.reason_enc, p_key),
    er.automated,
    er.status,
    er.error,
    er.created_at
  FROM public.executed_rules er
  LEFT JOIN public.folders f ON f.id = er.folder_id
  WHERE er.user_id = p_user_id
    AND (p_account_id IS NULL OR er.gmail_account_id = p_account_id)
    AND (p_folder_id IS NULL OR er.folder_id = p_folder_id)
    AND (p_cursor IS NULL OR er.created_at < p_cursor)
  ORDER BY er.created_at DESC
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;

REVOKE EXECUTE ON FUNCTION public.list_executed_rules(uuid, uuid, uuid, timestamptz, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_executed_rules(uuid, uuid, uuid, timestamptz, integer, text) TO service_role;
