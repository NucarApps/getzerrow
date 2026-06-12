-- ============================================================
-- Unblock sync: shell objects matching the deployed app contract
-- Encryption layer will be added in a follow-up pgcrypto migration.
-- ============================================================

-- 1. emails_decrypted view -----------------------------------
CREATE OR REPLACE VIEW public.emails_decrypted
WITH (security_invoker = true) AS
SELECT *
  FROM public.emails;

GRANT SELECT ON public.emails_decrypted TO authenticated, service_role;

-- 2. OAuth token RPCs ----------------------------------------
CREATE OR REPLACE FUNCTION public.get_gmail_oauth_tokens(p_account_id uuid)
RETURNS TABLE(access_token text, refresh_token text, token_expires_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ga.access_token, ga.refresh_token, ga.token_expires_at
    FROM public.gmail_accounts ga
   WHERE ga.id = p_account_id;
$$;

REVOKE ALL ON FUNCTION public.get_gmail_oauth_tokens(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.set_gmail_oauth_tokens(
  p_account_id uuid,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.gmail_accounts
     SET access_token      = p_access_token,
         refresh_token     = COALESCE(p_refresh_token, refresh_token),
         token_expires_at  = p_token_expires_at,
         updated_at        = now()
   WHERE id = p_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_gmail_oauth_account(
  p_user_id uuid,
  p_email_address text,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.gmail_accounts (
    user_id, email_address, access_token, refresh_token, token_expires_at
  ) VALUES (
    p_user_id, p_email_address, p_access_token, p_refresh_token, p_token_expires_at
  )
  ON CONFLICT (user_id, email_address) DO UPDATE
     SET access_token     = EXCLUDED.access_token,
         refresh_token    = EXCLUDED.refresh_token,
         token_expires_at = EXCLUDED.token_expires_at,
         updated_at       = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz) TO service_role;

-- 3. audit schema + decryption_log ---------------------------
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.decryption_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  caller       text NOT NULL DEFAULT current_user,
  kind         text NOT NULL CHECK (kind IN ('oauth', 'email_body')),
  row_id       uuid NULL,
  success      boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS decryption_log_occurred_at_idx
  ON audit.decryption_log (occurred_at DESC);

ALTER TABLE audit.decryption_log ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (which bypasses RLS) can read or write.

-- 4. list_decryption_audit RPC -------------------------------
CREATE OR REPLACE FUNCTION public.list_decryption_audit(p_limit int DEFAULT 100)
RETURNS TABLE(
  id          uuid,
  occurred_at timestamptz,
  caller      text,
  kind        text,
  row_id      uuid,
  success     boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, audit
AS $$
  SELECT id, occurred_at, caller, kind, row_id, success
    FROM audit.decryption_log
   ORDER BY occurred_at DESC
   LIMIT GREATEST(1, LEAST(p_limit, 1000));
$$;

REVOKE ALL ON FUNCTION public.list_decryption_audit(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_decryption_audit(int) TO service_role;