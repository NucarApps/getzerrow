CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1. Encrypted columns
ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS access_token_enc bytea,
  ADD COLUMN IF NOT EXISTS refresh_token_enc bytea;

-- Plaintext columns kept temporarily (still NOT NULL on the table); we'll
-- relax them so new rows can store only the encrypted copy.
ALTER TABLE public.gmail_accounts
  ALTER COLUMN access_token DROP NOT NULL,
  ALTER COLUMN refresh_token DROP NOT NULL;

-- 2. Private schema + audit-logging decrypt helper
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.decrypt_oauth_token(p_cipher bytea, p_key text, p_row_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, public, extensions
AS $$
DECLARE
  v_plain text;
BEGIN
  IF p_cipher IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v_plain := extensions.pgp_sym_decrypt(p_cipher, p_key);
    BEGIN
      INSERT INTO audit.decryption_log (caller, kind, row_id, success)
      VALUES (current_user, 'oauth', p_row_id, true);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RETURN v_plain;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO audit.decryption_log (caller, kind, row_id, success)
      VALUES (current_user, 'oauth', p_row_id, false);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    RAISE;
  END;
END;
$$;

-- 3. Redefined RPCs with key parameter
CREATE OR REPLACE FUNCTION public.get_gmail_oauth_tokens(p_account_id uuid, p_key text)
RETURNS TABLE(access_token text, refresh_token text, token_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(private.decrypt_oauth_token(ga.access_token_enc,  p_key, ga.id), ga.access_token),
    COALESCE(private.decrypt_oauth_token(ga.refresh_token_enc, p_key, ga.id), ga.refresh_token),
    ga.token_expires_at
  FROM public.gmail_accounts ga
  WHERE ga.id = p_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_gmail_oauth_tokens(
  p_account_id uuid,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz,
  p_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  UPDATE public.gmail_accounts
     SET access_token_enc  = extensions.pgp_sym_encrypt(p_access_token, p_key),
         refresh_token_enc = CASE
           WHEN p_refresh_token IS NULL OR p_refresh_token = ''
             THEN refresh_token_enc
             ELSE extensions.pgp_sym_encrypt(p_refresh_token, p_key)
         END,
         access_token      = NULL,
         refresh_token     = CASE
           WHEN p_refresh_token IS NULL OR p_refresh_token = ''
             THEN refresh_token
             ELSE NULL
         END,
         token_expires_at  = p_token_expires_at,
         updated_at        = now()
   WHERE id = p_account_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_gmail_oauth_account(
  p_user_id uuid,
  p_email_address text,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz,
  p_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
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
        access_token      = NULL,
        refresh_token     = NULL,
        token_expires_at  = EXCLUDED.token_expires_at,
        updated_at        = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Drop old keyless overloads so callers must pass the key
DROP FUNCTION IF EXISTS public.get_gmail_oauth_tokens(uuid);
DROP FUNCTION IF EXISTS public.set_gmail_oauth_tokens(uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz);

REVOKE ALL ON FUNCTION public.get_gmail_oauth_tokens(uuid, text)             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid, text)             TO service_role;
GRANT EXECUTE ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz, text) TO service_role;