
-- 1. Drop plaintext OAuth token columns from gmail_accounts (encrypted *_enc columns remain)
ALTER TABLE public.gmail_accounts DROP COLUMN IF EXISTS access_token;
ALTER TABLE public.gmail_accounts DROP COLUMN IF EXISTS refresh_token;

-- 2. Recreate get_gmail_oauth_tokens without the plaintext fallback
CREATE OR REPLACE FUNCTION public.get_gmail_oauth_tokens(p_account_id uuid, p_key text)
 RETURNS TABLE(access_token text, refresh_token text, token_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    private.decrypt_oauth_token(ga.access_token_enc,  p_key, ga.id),
    private.decrypt_oauth_token(ga.refresh_token_enc, p_key, ga.id),
    ga.token_expires_at
  FROM public.gmail_accounts ga
  WHERE ga.id = p_account_id;
END;
$function$;

-- 3. Update set_gmail_oauth_tokens to stop touching the dropped plaintext columns
CREATE OR REPLACE FUNCTION public.set_gmail_oauth_tokens(p_account_id uuid, p_access_token text, p_refresh_token text, p_token_expires_at timestamp with time zone, p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  UPDATE public.gmail_accounts
     SET access_token_enc  = extensions.pgp_sym_encrypt(p_access_token, p_key),
         refresh_token_enc = CASE
           WHEN p_refresh_token IS NULL OR p_refresh_token = ''
             THEN refresh_token_enc
             ELSE extensions.pgp_sym_encrypt(p_refresh_token, p_key)
         END,
         token_expires_at  = p_token_expires_at,
         updated_at        = now()
   WHERE id = p_account_id;
END;
$function$;

-- 4. Update upsert_gmail_oauth_account to stop referencing dropped columns
CREATE OR REPLACE FUNCTION public.upsert_gmail_oauth_account(p_user_id uuid, p_email_address text, p_access_token text, p_refresh_token text, p_token_expires_at timestamp with time zone, p_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.gmail_accounts (
    user_id, email_address,
    access_token_enc, refresh_token_enc,
    token_expires_at
  ) VALUES (
    p_user_id, p_email_address,
    extensions.pgp_sym_encrypt(p_access_token,  p_key),
    extensions.pgp_sym_encrypt(p_refresh_token, p_key),
    p_token_expires_at
  )
  ON CONFLICT (user_id, email_address) DO UPDATE
    SET access_token_enc  = EXCLUDED.access_token_enc,
        refresh_token_enc = EXCLUDED.refresh_token_enc,
        token_expires_at  = EXCLUDED.token_expires_at,
        updated_at        = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

-- 5. Lock down SECURITY DEFINER functions that should only be called by trusted server code
REVOKE EXECUTE ON FUNCTION public.list_decryption_audit(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamp with time zone, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamp with time zone, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_message_jobs(integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_forward_retries(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bump_history_id_if_greater(uuid, text, timestamp with time zone) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_pubsub_events(integer, integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_dlq_jobs(integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cron_secret_matches(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer) FROM anon, authenticated;
