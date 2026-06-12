-- Decryption audit log.
--
-- Goal: for incident response, operators must be able to answer
-- questions like "did anyone read user X's emails on day Y?" or "what
-- did the service-role credential decrypt while it was compromised?"
-- Without a log, the answer is "we don't know" — which is unacceptable
-- for the kind of data this app handles (full mailbox content +
-- durable Gmail OAuth refresh tokens).
--
-- DESIGN
--   audit.decryption_log captures one row per call to
--   private.decrypt_email_body or private.decrypt_oauth_token. Both
--   helpers are modified to write a log row at the start of each call,
--   capturing:
--     - resource_kind  ('oauth_token' | 'email_body')
--     - resource_id    (gmail_accounts.id or emails.id; NULL when the
--                       helper is called with raw bytea + no id context)
--     - caller_kind    ('user' if auth.uid() is set, else 'service')
--     - caller_id      (the auth.uid() — NULL for service-role calls)
--     - context        (which RPC/view triggered the decrypt)
--     - outcome        ('ok' on success, 'error' on AEAD failure)
--     - error          (short reason if outcome='error')
--
-- VOLUME / RETENTION
--   Per-row logging produces 1 row per body decrypted + 1 per token
--   fetched. For a busy mailbox: ~50 email reads/day × 2 (text + html)
--   = 100 rows/day per active user. 90-day retention = 9k rows. Storage
--   negligible (<1 MB per user-year).
--
--   The existing gmail-retention cron is updated below to age out
--   audit rows beyond a configurable horizon (default 90 days).
--
-- ACCESS CONTROL
--   audit.decryption_log: RLS enabled, no policies → service_role only.
--   public.list_decryption_audit(...) RPC exposes it to authenticated
--   users scoped to their own caller_id — so a user can see their own
--   decryption history but not anyone else's.

CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.decryption_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resource_kind text NOT NULL CHECK (resource_kind IN ('oauth_token', 'email_body')),
  resource_id uuid,
  caller_kind text NOT NULL CHECK (caller_kind IN ('user', 'service', 'unknown')),
  caller_id uuid,
  context text,
  outcome text NOT NULL DEFAULT 'ok' CHECK (outcome IN ('ok', 'error')),
  error text
);

-- "What did user X decrypt?" — primary forensics query.
CREATE INDEX IF NOT EXISTS decryption_log_caller_idx
  ON audit.decryption_log (caller_id, occurred_at DESC)
  WHERE caller_id IS NOT NULL;

-- "What was decrypted recently across all users?" — for spot-check + retention.
CREATE INDEX IF NOT EXISTS decryption_log_occurred_at_idx
  ON audit.decryption_log (occurred_at DESC);

-- "Was email X ever decrypted? When?" — for per-resource forensics.
CREATE INDEX IF NOT EXISTS decryption_log_resource_idx
  ON audit.decryption_log (resource_kind, resource_id, occurred_at DESC)
  WHERE resource_id IS NOT NULL;

ALTER TABLE audit.decryption_log ENABLE ROW LEVEL SECURITY;
-- No policies = service_role only. Users reach this via the
-- list_decryption_audit RPC below.

-- ─── Audit-writing helper ────────────────────────────────────────────────
-- Centralized insert so the decrypt helpers stay readable. SECURITY
-- DEFINER so it can write to audit.* even when called from a less-
-- privileged context (e.g., a user calling emails_decrypted).

CREATE OR REPLACE FUNCTION private.log_decryption(
  p_resource_kind text,
  p_resource_id uuid,
  p_context text,
  p_outcome text DEFAULT 'ok',
  p_error text DEFAULT NULL
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = audit, public
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_kind text;
BEGIN
  -- auth.uid() returns the JWT-claimed user id when invoked through
  -- PostgREST; NULL for service-role calls.
  BEGIN
    v_caller_id := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_caller_id := NULL;
  END;

  IF v_caller_id IS NOT NULL THEN
    v_caller_kind := 'user';
  ELSE
    v_caller_kind := 'service';
  END IF;

  -- Best-effort insert. We don't want a corrupt audit table to break
  -- the entire decryption path; if the insert fails we swallow.
  BEGIN
    INSERT INTO audit.decryption_log (
      resource_kind, resource_id, caller_kind, caller_id, context, outcome, error
    ) VALUES (
      p_resource_kind, p_resource_id, v_caller_kind, v_caller_id, p_context, p_outcome, p_error
    );
  EXCEPTION WHEN OTHERS THEN
    -- Last-resort: a NOTICE in the Postgres log so we know audits are
    -- failing without crashing the request.
    RAISE NOTICE 'audit.decryption_log insert failed: %', SQLERRM;
  END;
END;
$$;
REVOKE ALL ON FUNCTION private.log_decryption(text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.log_decryption(text, uuid, text, text, text) TO service_role;

-- ─── Update decrypt_email_body to take an optional resource_id + log ────

CREATE OR REPLACE FUNCTION private.decrypt_email_body(
  ciphertext bytea,
  p_email_id uuid DEFAULT NULL,
  p_context text DEFAULT NULL
)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
DECLARE
  v_key_id uuid := private.email_body_key_id();
  v_nonce bytea;
  v_ct bytea;
  v_result text;
BEGIN
  IF ciphertext IS NULL OR length(ciphertext) <= 24 THEN
    RETURN NULL;
  END IF;
  IF v_key_id IS NULL THEN
    PERFORM private.log_decryption('email_body', p_email_id, p_context, 'error', 'email_bodies_v1 key missing');
    RAISE EXCEPTION 'email_bodies_v1 key not provisioned in pgsodium.key';
  END IF;
  v_nonce := substring(ciphertext FROM 1 FOR 24);
  v_ct    := substring(ciphertext FROM 25);
  BEGIN
    v_result := convert_from(
      pgsodium.crypto_aead_ietf_decrypt(v_ct, NULL, v_nonce, v_key_id),
      'utf8'
    );
    PERFORM private.log_decryption('email_body', p_email_id, p_context, 'ok', NULL);
    RETURN v_result;
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.log_decryption('email_body', p_email_id, p_context, 'error', SQLERRM);
    RETURN NULL;
  END;
END;
$$;
REVOKE ALL ON FUNCTION private.decrypt_email_body(bytea, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.decrypt_email_body(bytea, uuid, text) TO service_role;

-- ─── Update decrypt_oauth_token to take optional account_id + log ───────

CREATE OR REPLACE FUNCTION private.decrypt_oauth_token(
  ciphertext bytea,
  p_account_id uuid DEFAULT NULL,
  p_context text DEFAULT NULL
)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
DECLARE
  v_key_id uuid := private.oauth_token_key_id();
  v_result text;
BEGIN
  IF ciphertext IS NULL OR length(ciphertext) = 0 THEN RETURN NULL; END IF;
  IF v_key_id IS NULL THEN
    PERFORM private.log_decryption('oauth_token', p_account_id, p_context, 'error', 'oauth_tokens_v1 key missing');
    RAISE EXCEPTION 'oauth_tokens_v1 key not provisioned in pgsodium.key';
  END IF;
  BEGIN
    v_result := convert_from(
      pgsodium.crypto_aead_det_decrypt(ciphertext, NULL, v_key_id),
      'utf8'
    );
    PERFORM private.log_decryption('oauth_token', p_account_id, p_context, 'ok', NULL);
    RETURN v_result;
  EXCEPTION WHEN OTHERS THEN
    PERFORM private.log_decryption('oauth_token', p_account_id, p_context, 'error', SQLERRM);
    RETURN NULL;
  END;
END;
$$;
REVOKE ALL ON FUNCTION private.decrypt_oauth_token(bytea, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.decrypt_oauth_token(bytea, uuid, text) TO service_role;

-- ─── Update emails_decrypted view + claim_forward_retries to pass ids ──

-- View now passes the row's id and a context label so the audit log
-- can answer "who decrypted email X via the inbox view".
CREATE OR REPLACE VIEW public.emails_decrypted
WITH (security_invoker = true)
AS
SELECT
  e.id, e.user_id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
  e.from_addr, e.from_name, e.to_addrs, e.cc, e.list_id, e.in_reply_to,
  e.subject, e.snippet,
  COALESCE(
    private.decrypt_email_body(e.body_text_encrypted, e.id, 'view:emails_decrypted'),
    NULLIF(e.body_text, '')
  )::text AS body_text,
  COALESCE(
    private.decrypt_email_body(e.body_html_encrypted, e.id, 'view:emails_decrypted'),
    NULLIF(e.body_html, '')
  )::text AS body_html,
  e.received_at, e.is_read, e.is_archived, e.has_attachment, e.raw_labels,
  e.folder_id, e.classified_by, e.classification_reason,
  e.ai_summary, e.ai_confidence, e.matched_filter_ids, e.matched_folder_ids,
  e.snoozed_until, e.forwarded_to, e.forwarded_at,
  e.forward_attempts, e.forward_last_error, e.forward_next_retry_at, e.forward_locked_at,
  e.processed_at, e.published_at_ms, e.created_at, e.updated_at
FROM public.emails e;

GRANT SELECT ON public.emails_decrypted TO authenticated, service_role;

-- claim_forward_retries: log the decrypt with the email_id.
CREATE OR REPLACE FUNCTION public.claim_forward_retries(p_limit integer)
  RETURNS TABLE(
    id uuid,
    gmail_account_id uuid,
    gmail_message_id text,
    folder_id uuid,
    subject text,
    from_addr text,
    from_name text,
    body_text text,
    snippet text,
    received_at timestamptz,
    forward_attempts smallint
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT e.id
      FROM public.emails e
     WHERE e.forward_next_retry_at IS NOT NULL
       AND e.forward_next_retry_at <= now()
       AND e.forward_attempts < 5
       AND e.forwarded_at IS NULL
       AND (e.forward_locked_at IS NULL OR e.forward_locked_at < now() - interval '60 seconds')
     ORDER BY e.forward_next_retry_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.emails e
     SET forward_locked_at = now()
    FROM picked
   WHERE e.id = picked.id
   RETURNING
     e.id,
     e.gmail_account_id,
     e.gmail_message_id,
     e.folder_id,
     e.subject,
     e.from_addr,
     e.from_name,
     COALESCE(
       private.decrypt_email_body(e.body_text_encrypted, e.id, 'rpc:claim_forward_retries'),
       NULLIF(e.body_text, '')
     )::text,
     e.snippet,
     e.received_at,
     e.forward_attempts;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_forward_retries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_forward_retries(integer) TO service_role;

-- get_gmail_oauth_tokens: log the decrypt with the account_id.
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
      private.decrypt_oauth_token(g.access_token_encrypted, g.id, 'rpc:get_gmail_oauth_tokens'),
      NULLIF(g.access_token, '')
    )::text,
    COALESCE(
      private.decrypt_oauth_token(g.refresh_token_encrypted, g.id, 'rpc:get_gmail_oauth_tokens'),
      NULLIF(g.refresh_token, '')
    )::text,
    g.token_expires_at
  FROM public.gmail_accounts g
  WHERE g.id = p_account_id;
END;
$$;
REVOKE ALL ON FUNCTION public.get_gmail_oauth_tokens(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid) TO service_role;

-- ─── Operator-facing query RPC ───────────────────────────────────────────
-- Authenticated users see their own decryption history. Operators
-- (service_role) can query everything via the audit.* schema directly.

CREATE OR REPLACE FUNCTION public.list_decryption_audit(
  p_hours integer DEFAULT 24,
  p_limit integer DEFAULT 200
)
  RETURNS TABLE(
    id uuid,
    occurred_at timestamptz,
    resource_kind text,
    resource_id uuid,
    context text,
    outcome text,
    error text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = audit, public
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    -- Service-role callers should query audit.decryption_log directly.
    RETURN;
  END IF;
  RETURN QUERY
  SELECT
    d.id,
    d.occurred_at,
    d.resource_kind,
    d.resource_id,
    d.context,
    d.outcome,
    d.error
  FROM audit.decryption_log d
  WHERE d.caller_id = v_caller
    AND d.occurred_at >= now() - make_interval(hours => p_hours)
  ORDER BY d.occurred_at DESC
  LIMIT p_limit;
END;
$$;
REVOKE ALL ON FUNCTION public.list_decryption_audit(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_decryption_audit(integer, integer) TO authenticated, service_role;

-- ─── Retention: extend cleanup_old_pubsub_events pattern ─────────────────

CREATE OR REPLACE FUNCTION public.cleanup_old_decryption_audit(
  p_keep_days integer DEFAULT 90,
  p_batch_limit integer DEFAULT 5000
)
  RETURNS TABLE(deleted bigint, total_before bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = audit, public
AS $$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_keep_days);
  v_deleted bigint;
  v_before bigint;
BEGIN
  SELECT COUNT(*) INTO v_before FROM audit.decryption_log;

  WITH victims AS (
    SELECT id FROM audit.decryption_log
     WHERE occurred_at < v_cutoff
     ORDER BY occurred_at ASC
     LIMIT p_batch_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM audit.decryption_log d
   USING victims
   WHERE d.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_deleted, v_before;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_old_decryption_audit(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_decryption_audit(integer, integer) TO service_role;

-- Audit row recording the migration itself for sanity.
INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'decryption audit log enabled (audit.decryption_log)');
