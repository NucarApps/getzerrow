-- Encrypt OAuth tokens at rest.
--
-- Why
--   gmail_accounts.access_token + refresh_token are stored as plaintext
--   TEXT. A database leak (logical replication snapshot, backup theft,
--   compromised service-role credential) gives an attacker durable
--   access to every connected Gmail mailbox — refresh tokens don't
--   expire on their own. This migration moves them to AEAD-encrypted
--   bytea columns and gates read/write behind SECURITY DEFINER RPCs.
--
-- Design
--   * Uses pgsodium's deterministic AEAD (crypto_aead_det_*). No nonce
--     management; identical plaintexts produce identical ciphertexts.
--     Fine here because OAuth tokens are random ≥160-bit secrets, so
--     equality leakage is meaningless.
--   * Key lives in pgsodium.key under name 'oauth_tokens_v1'. The
--     underlying master key is managed by Supabase via
--     pgsodium_server_key — we never see raw key bytes.
--   * Dual-column strategy during migration: plaintext columns kept
--     non-null (default '') so the schema doesn't break old code paths
--     during deploy. A follow-up migration will drop them once code is
--     fully cut over.
--
-- Reversibility
--   To roll back, ALTER TABLE DROP COLUMN access_token_encrypted /
--   refresh_token_encrypted. Plaintext columns still hold the original
--   tokens if you DON'T run a deploy that calls set_gmail_oauth_tokens
--   (which nulls them out). Once a token has been refreshed via the
--   new RPC the plaintext is gone — no path back without re-OAuth.
--
-- Operator action: nothing. The pgsodium key auto-creates on first run.

CREATE EXTENSION IF NOT EXISTS pgsodium;

-- ─── Key provisioning ────────────────────────────────────────────────────
-- Idempotent. pgsodium.create_key writes the (wrapped) key into the
-- managed keyring; subsequent migration runs are no-ops.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgsodium.key WHERE name = 'oauth_tokens_v1') THEN
    PERFORM pgsodium.create_key(name => 'oauth_tokens_v1');
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.oauth_token_key_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
  SELECT id FROM pgsodium.key WHERE name = 'oauth_tokens_v1' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION private.oauth_token_key_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.oauth_token_key_id() TO service_role;

-- ─── Encrypted columns ───────────────────────────────────────────────────
ALTER TABLE public.gmail_accounts
  ADD COLUMN IF NOT EXISTS access_token_encrypted bytea,
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted bytea;

-- ─── Encrypt / decrypt helpers (SECURITY DEFINER, service_role only) ─────

CREATE OR REPLACE FUNCTION private.encrypt_oauth_token(plaintext text)
  RETURNS bytea
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
DECLARE
  v_key_id uuid := private.oauth_token_key_id();
BEGIN
  IF plaintext IS NULL OR length(plaintext) = 0 THEN RETURN NULL; END IF;
  IF v_key_id IS NULL THEN
    RAISE EXCEPTION 'oauth_tokens_v1 key not provisioned in pgsodium.key';
  END IF;
  RETURN pgsodium.crypto_aead_det_encrypt(
    convert_to(plaintext, 'utf8'),
    NULL,
    v_key_id
  );
END;
$$;
REVOKE ALL ON FUNCTION private.encrypt_oauth_token(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.encrypt_oauth_token(text) TO service_role;

CREATE OR REPLACE FUNCTION private.decrypt_oauth_token(ciphertext bytea)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
DECLARE
  v_key_id uuid := private.oauth_token_key_id();
BEGIN
  IF ciphertext IS NULL OR length(ciphertext) = 0 THEN RETURN NULL; END IF;
  IF v_key_id IS NULL THEN
    RAISE EXCEPTION 'oauth_tokens_v1 key not provisioned in pgsodium.key';
  END IF;
  RETURN convert_from(
    pgsodium.crypto_aead_det_decrypt(ciphertext, NULL, v_key_id),
    'utf8'
  );
END;
$$;
REVOKE ALL ON FUNCTION private.decrypt_oauth_token(bytea) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.decrypt_oauth_token(bytea) TO service_role;

-- ─── Public RPCs (the only interface the application uses) ───────────────

-- Used by the token-refresh path. Pass empty/null p_refresh_token to
-- preserve the existing refresh token (Google only returns a refresh
-- token on the initial consent flow).
CREATE OR REPLACE FUNCTION public.set_gmail_oauth_tokens(
  p_account_id uuid,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  UPDATE public.gmail_accounts
     SET access_token_encrypted = private.encrypt_oauth_token(p_access_token),
         refresh_token_encrypted = CASE
           WHEN p_refresh_token IS NOT NULL AND length(p_refresh_token) > 0
             THEN private.encrypt_oauth_token(p_refresh_token)
           ELSE refresh_token_encrypted
         END,
         token_expires_at = p_token_expires_at,
         -- Zero out plaintext columns. NOT NULL constraints prevent
         -- NULL; sentinel '' tells reads "use the encrypted column".
         access_token = '',
         refresh_token = CASE
           WHEN p_refresh_token IS NOT NULL AND length(p_refresh_token) > 0
             THEN ''
           ELSE refresh_token
         END,
         updated_at = now()
   WHERE id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz) TO service_role;

-- Used by the OAuth callback (first-time connect) and by
-- connectGmailFromSession (Lovable Cloud session bridge).
CREATE OR REPLACE FUNCTION public.upsert_gmail_oauth_account(
  p_user_id uuid,
  p_email_address text,
  p_access_token text,
  p_refresh_token text,
  p_token_expires_at timestamptz
)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_account_id uuid;
BEGIN
  INSERT INTO public.gmail_accounts (
    user_id, email_address,
    access_token, refresh_token, token_expires_at,
    access_token_encrypted, refresh_token_encrypted
  ) VALUES (
    p_user_id, p_email_address,
    '', '',
    p_token_expires_at,
    private.encrypt_oauth_token(p_access_token),
    private.encrypt_oauth_token(p_refresh_token)
  )
  ON CONFLICT (user_id, email_address) DO UPDATE SET
    access_token = '',
    refresh_token = CASE
      WHEN EXCLUDED.refresh_token_encrypted IS NOT NULL
        THEN ''
      ELSE public.gmail_accounts.refresh_token
    END,
    token_expires_at = EXCLUDED.token_expires_at,
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    refresh_token_encrypted = COALESCE(
      EXCLUDED.refresh_token_encrypted,
      public.gmail_accounts.refresh_token_encrypted
    ),
    updated_at = now()
  RETURNING id INTO v_account_id;
  RETURN v_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz) TO service_role;

-- Used by getAccessToken (the hot path on every Gmail API call).
-- Falls back to plaintext column when encrypted is null — bridges the
-- gap between deploy time and backfill completion.
CREATE OR REPLACE FUNCTION public.get_gmail_oauth_tokens(p_account_id uuid)
  RETURNS TABLE(
    access_token text,
    refresh_token text,
    token_expires_at timestamptz
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(
      private.decrypt_oauth_token(g.access_token_encrypted),
      NULLIF(g.access_token, '')
    )::text,
    COALESCE(
      private.decrypt_oauth_token(g.refresh_token_encrypted),
      NULLIF(g.refresh_token, '')
    )::text,
    g.token_expires_at
  FROM public.gmail_accounts g
  WHERE g.id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_gmail_oauth_tokens(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid) TO service_role;

-- ─── Backfill ────────────────────────────────────────────────────────────
-- Encrypt every existing plaintext token. Re-running is a no-op because
-- the WHERE clause excludes already-encrypted rows.
DO $$
DECLARE
  rec record;
  v_count integer := 0;
BEGIN
  IF private.oauth_token_key_id() IS NULL THEN
    RAISE NOTICE 'oauth_tokens_v1 key not provisioned. Backfill skipped — re-run after key exists.';
    RETURN;
  END IF;
  FOR rec IN
    SELECT id, access_token, refresh_token
      FROM public.gmail_accounts
     WHERE access_token_encrypted IS NULL
       AND access_token IS NOT NULL
       AND length(access_token) > 0
  LOOP
    UPDATE public.gmail_accounts
       SET access_token_encrypted = private.encrypt_oauth_token(rec.access_token),
           refresh_token_encrypted = private.encrypt_oauth_token(rec.refresh_token),
           access_token = '',
           refresh_token = ''
     WHERE id = rec.id;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'oauth-token backfill: encrypted % gmail_accounts row(s).', v_count;
END $$;
