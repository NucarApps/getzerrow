-- Defense-in-depth: assert caller identity inside the Gmail OAuth token RPCs.
--
-- get/set/upsert_gmail_oauth_tokens are SECURITY DEFINER (they read/write
-- encrypted refresh tokens for any account) and are REVOKE'd from anon +
-- authenticated — only service_role may call them today. That REVOKE/GRANT
-- boundary is the sole thing standing between a client and every mailbox's
-- tokens: one erroneous GRANT would expose cross-tenant token read/write.
--
-- These functions previously trusted p_account_id / p_user_id with no identity
-- check. This migration adds a belt-and-braces assertion: when a real end-user
-- JWT is present (auth.uid() IS NOT NULL) the target must belong to that user.
-- Service-role callers have auth.uid() = NULL and are unaffected, so the live
-- server paths behave identically. Bodies are otherwise reproduced verbatim
-- from 20260525224201 (the current pgcrypto/p_key definitions).
--
-- Idempotent: CREATE OR REPLACE, signatures preserved.

-- get_gmail_oauth_tokens(p_account_id, p_key)
CREATE OR REPLACE FUNCTION public.get_gmail_oauth_tokens(p_account_id uuid, p_key text)
 RETURNS TABLE(access_token text, refresh_token text, token_expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND (SELECT ga.user_id FROM public.gmail_accounts ga WHERE ga.id = p_account_id)
         IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden: account does not belong to the authenticated user';
  END IF;

  RETURN QUERY
  SELECT
    private.decrypt_oauth_token(ga.access_token_enc,  p_key, ga.id),
    private.decrypt_oauth_token(ga.refresh_token_enc, p_key, ga.id),
    ga.token_expires_at
  FROM public.gmail_accounts ga
  WHERE ga.id = p_account_id;
END;
$function$;

-- set_gmail_oauth_tokens(p_account_id, p_access_token, p_refresh_token, p_token_expires_at, p_key)
CREATE OR REPLACE FUNCTION public.set_gmail_oauth_tokens(p_account_id uuid, p_access_token text, p_refresh_token text, p_token_expires_at timestamp with time zone, p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND (SELECT ga.user_id FROM public.gmail_accounts ga WHERE ga.id = p_account_id)
         IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden: account does not belong to the authenticated user';
  END IF;

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

-- upsert_gmail_oauth_account(p_user_id, p_email_address, p_access_token, p_refresh_token, p_token_expires_at, p_key)
CREATE OR REPLACE FUNCTION public.upsert_gmail_oauth_account(p_user_id uuid, p_email_address text, p_access_token text, p_refresh_token text, p_token_expires_at timestamp with time zone, p_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden: p_user_id does not match the authenticated user';
  END IF;

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

-- Preserve the client lockdown (CREATE OR REPLACE keeps prior grants, but be explicit).
REVOKE EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamp with time zone, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamp with time zone, text) FROM anon, authenticated;
