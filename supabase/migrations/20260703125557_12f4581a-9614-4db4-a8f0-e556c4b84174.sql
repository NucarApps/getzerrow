CREATE OR REPLACE FUNCTION public.insert_folder_example_encrypted(p_user_id uuid, p_gmail_account_id uuid, p_folder_id uuid, p_gmail_message_id text, p_from_addr text, p_subject text, p_snippet text, p_source text, p_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.folder_examples (
    user_id, gmail_account_id, folder_id, gmail_message_id,
    from_addr,
    subject_enc,
    snippet_enc,
    source, key_version
  ) VALUES (
    p_user_id, p_gmail_account_id, p_folder_id, p_gmail_message_id,
    p_from_addr,
    private.encrypt_text(p_subject, p_key),
    private.encrypt_text(p_snippet, p_key),
    COALESCE(p_source, 'seed'), 1
  )
  ON CONFLICT (folder_id, gmail_message_id) DO UPDATE SET
    from_addr   = EXCLUDED.from_addr,
    subject_enc = EXCLUDED.subject_enc,
    snippet_enc = EXCLUDED.snippet_enc,
    source      = EXCLUDED.source
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;