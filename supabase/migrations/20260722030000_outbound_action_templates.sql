-- Outbound email actions (rules upgrade, task 8): reply / draft /
-- send_email with encrypted body templates.
--
-- The folder_actions columns (subject_template, body_template_enc,
-- to_addr, cc_addr, bcc_addr) were reserved by the task-4 migration —
-- this adds only the SECURITY DEFINER accessors, mirroring the task-5
-- webhook pair: templates are written encrypted with EMAIL_ENC_KEY via
-- private.encrypt_text and only the service-role runner can decrypt.

CREATE OR REPLACE FUNCTION public.set_folder_action_template(
  p_action_id uuid,
  p_user_id uuid,
  p_subject text,
  p_body text,
  p_to text,
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
  -- Bound user-supplied template inputs (ReDoS/DoS invariant): the app
  -- enforces 4000 chars too; this is the defense-in-depth backstop.
  IF length(coalesce(p_body, '')) > 4000 OR length(coalesce(p_subject, '')) > 500 THEN
    RAISE EXCEPTION 'template too long';
  END IF;
  UPDATE public.folder_actions
     SET subject_template = p_subject,
         body_template_enc = CASE
           WHEN p_body IS NULL OR p_body = '' THEN NULL
           ELSE private.encrypt_text(p_body, p_key)
         END,
         to_addr = p_to
   WHERE id = p_action_id
     AND user_id = p_user_id
     AND action_type IN ('reply', 'draft', 'send_email');
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_folder_action_template(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_folder_action_template(uuid, uuid, text, text, text, text) TO service_role;

-- Decrypt an outbound action's config for the runner (service-role only).
CREATE OR REPLACE FUNCTION public.get_folder_action_outbound(
  p_action_id uuid,
  p_key text
)
RETURNS TABLE(
  subject_template text,
  body_template text,
  to_addr text,
  cc_addr text,
  bcc_addr text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $$
  SELECT
    fa.subject_template,
    CASE
      WHEN fa.body_template_enc IS NULL THEN NULL
      ELSE private.decrypt_text(fa.body_template_enc, p_key)
    END AS body_template,
    fa.to_addr,
    fa.cc_addr,
    fa.bcc_addr
  FROM public.folder_actions fa
  WHERE fa.id = p_action_id
    AND fa.action_type IN ('reply', 'draft', 'send_email');
$$;

REVOKE EXECUTE ON FUNCTION public.get_folder_action_outbound(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_folder_action_outbound(uuid, text) TO service_role;
