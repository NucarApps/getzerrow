DROP FUNCTION IF EXISTS public.get_emails_list_fields_decrypted(uuid[], text);

CREATE FUNCTION public.get_emails_list_fields_decrypted(p_ids uuid[], p_key text)
RETURNS TABLE (
  id uuid,
  ai_summary text,
  classification_reason text,
  subject text,
  snippet text,
  from_name text,
  to_addrs text,
  cc text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public','private','extensions'
AS $$
  SELECT
    e.id,
    private.decrypt_text(e.ai_summary_enc, p_key),
    private.decrypt_text(e.classification_reason_enc, p_key),
    private.decrypt_text(e.subject_enc, p_key),
    private.decrypt_text(e.snippet_enc, p_key),
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.to_addrs_enc, p_key),
    private.decrypt_text(e.cc_enc, p_key)
  FROM public.emails e
  WHERE e.id = ANY(p_ids);
$$;