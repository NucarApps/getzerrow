-- Encrypt email bodies at rest.
--
-- Why
--   emails.body_text + body_html are stored as plaintext. They contain
--   password reset links, financial correspondence, medical exchanges,
--   contracts, etc. A DB leak = full mailbox dump. This migration moves
--   the body content to AEAD-encrypted bytea columns. OAuth tokens were
--   handled in 20260525210000; this is the second half of the at-rest
--   encryption story.
--
-- Design
--   BEFORE INSERT / UPDATE trigger does the encryption transparently:
--   application code keeps writing `body_text` / `body_html` columns; the
--   trigger encrypts the values into `body_text_encrypted` /
--   `body_html_encrypted` bytea columns and zeros out the plaintext
--   columns *before the row is persisted*. Plaintext never hits disk.
--
--   Reads go through a `emails_decrypted` view (`security_invoker = true`,
--   so the caller's RLS still applies). The view returns decrypted text
--   in the same body_text / body_html columns the application already
--   knows. Switching a read site is a one-token find-replace:
--      .from("emails")  →  .from("emails_decrypted")
--
-- Encryption choice
--   xchacha20-poly1305-ietf with a fresh random 24-byte nonce per row.
--   Non-deterministic so identical body content (signature blocks,
--   "Sent from my iPhone") doesn't produce identical ciphertexts.
--   Nonce is prepended to the ciphertext for storage.
--
-- Reversibility
--   ALTER TABLE DROP the encrypted columns + DROP TRIGGER. Plaintext
--   columns stay '' for rows already migrated — those bodies are gone
--   without the key.

CREATE EXTENSION IF NOT EXISTS pgsodium;

-- ─── Key provisioning ────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgsodium.key WHERE name = 'email_bodies_v1') THEN
    PERFORM pgsodium.create_key(name => 'email_bodies_v1');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION private.email_body_key_id()
  RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
  SELECT id FROM pgsodium.key WHERE name = 'email_bodies_v1' LIMIT 1;
$$;
REVOKE ALL ON FUNCTION private.email_body_key_id() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.email_body_key_id() TO service_role;

-- ─── Encrypted columns ───────────────────────────────────────────────────
ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS body_text_encrypted bytea,
  ADD COLUMN IF NOT EXISTS body_html_encrypted bytea;

-- ─── Encrypt / decrypt helpers ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.encrypt_email_body(plaintext text)
  RETURNS bytea
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
DECLARE
  v_key_id uuid := private.email_body_key_id();
  v_nonce bytea;
BEGIN
  IF plaintext IS NULL OR length(plaintext) = 0 THEN RETURN NULL; END IF;
  IF v_key_id IS NULL THEN
    RAISE EXCEPTION 'email_bodies_v1 key not provisioned in pgsodium.key';
  END IF;
  -- 24-byte nonce for xchacha20-poly1305-ietf.
  v_nonce := pgsodium.randombytes_buf(24);
  RETURN v_nonce || pgsodium.crypto_aead_ietf_encrypt(
    convert_to(plaintext, 'utf8'),
    NULL,                                       -- no associated data
    v_nonce,
    v_key_id
  );
END;
$$;
REVOKE ALL ON FUNCTION private.encrypt_email_body(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.encrypt_email_body(text) TO service_role;

CREATE OR REPLACE FUNCTION private.decrypt_email_body(ciphertext bytea)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
DECLARE
  v_key_id uuid := private.email_body_key_id();
  v_nonce bytea;
  v_ct bytea;
BEGIN
  IF ciphertext IS NULL OR length(ciphertext) <= 24 THEN RETURN NULL; END IF;
  IF v_key_id IS NULL THEN
    RAISE EXCEPTION 'email_bodies_v1 key not provisioned in pgsodium.key';
  END IF;
  v_nonce := substring(ciphertext FROM 1 FOR 24);
  v_ct    := substring(ciphertext FROM 25);
  RETURN convert_from(
    pgsodium.crypto_aead_ietf_decrypt(v_ct, NULL, v_nonce, v_key_id),
    'utf8'
  );
EXCEPTION WHEN OTHERS THEN
  -- Decryption failures (key rotated, ciphertext tampered) return NULL
  -- instead of raising — keeps the view usable for non-body columns.
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.decrypt_email_body(bytea) FROM PUBLIC, anon, authenticated;
-- Authenticated callers reach this through the emails_decrypted view —
-- they don't need direct execute on the helper.
GRANT EXECUTE ON FUNCTION private.decrypt_email_body(bytea) TO service_role;

-- ─── Trigger: encrypt on write, zero the plaintext columns ───────────────

CREATE OR REPLACE FUNCTION private.emails_encrypt_body_trigger()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pgsodium, public
AS $$
DECLARE
  v_key_id uuid := private.email_body_key_id();
  v_nonce bytea;
BEGIN
  -- If the key isn't ready, pass through unchanged rather than fail
  -- the write. (Re-running this migration provisions the key.)
  IF v_key_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.body_text IS NOT NULL AND length(NEW.body_text) > 0 THEN
    v_nonce := pgsodium.randombytes_buf(24);
    NEW.body_text_encrypted := v_nonce || pgsodium.crypto_aead_ietf_encrypt(
      convert_to(NEW.body_text, 'utf8'),
      NULL,
      v_nonce,
      v_key_id
    );
    NEW.body_text := '';
  END IF;

  IF NEW.body_html IS NOT NULL AND length(NEW.body_html) > 0 THEN
    v_nonce := pgsodium.randombytes_buf(24);
    NEW.body_html_encrypted := v_nonce || pgsodium.crypto_aead_ietf_encrypt(
      convert_to(NEW.body_html, 'utf8'),
      NULL,
      v_nonce,
      v_key_id
    );
    NEW.body_html := '';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS emails_encrypt_body ON public.emails;
CREATE TRIGGER emails_encrypt_body
  BEFORE INSERT OR UPDATE OF body_text, body_html ON public.emails
  FOR EACH ROW
  EXECUTE FUNCTION private.emails_encrypt_body_trigger();

-- ─── emails_decrypted view ───────────────────────────────────────────────
-- security_invoker so the caller's RLS still applies (a user can only
-- see their own emails). decrypt_email_body is SECURITY DEFINER so the
-- view can decrypt even though the user lacks direct pgsodium access.
--
-- Note: CREATE OR REPLACE VIEW preserves dependent objects. Drop+create
-- pattern would invalidate downstream views/grants.

CREATE OR REPLACE VIEW public.emails_decrypted
WITH (security_invoker = true)
AS
SELECT
  e.id, e.user_id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
  e.from_addr, e.from_name, e.to_addrs, e.cc, e.list_id, e.in_reply_to,
  e.subject, e.snippet,
  COALESCE(private.decrypt_email_body(e.body_text_encrypted), NULLIF(e.body_text, ''))::text  AS body_text,
  COALESCE(private.decrypt_email_body(e.body_html_encrypted), NULLIF(e.body_html, ''))::text  AS body_html,
  e.received_at, e.is_read, e.is_archived, e.has_attachment, e.raw_labels,
  e.folder_id, e.classified_by, e.classification_reason,
  e.ai_summary, e.ai_confidence, e.matched_filter_ids, e.matched_folder_ids,
  e.snoozed_until, e.forwarded_to, e.forwarded_at,
  e.forward_attempts, e.forward_last_error, e.forward_next_retry_at, e.forward_locked_at,
  e.processed_at, e.published_at_ms, e.created_at, e.updated_at
FROM public.emails e;

GRANT SELECT ON public.emails_decrypted TO authenticated, service_role;

-- ─── Update claim_forward_retries to return decrypted body ───────────────
-- The forward-retry path needs plaintext body_text to compose the
-- forwarded message. Re-define the RPC to read from emails_decrypted.

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
     -- Decrypt body_text for the forward composer. Falls back to
     -- plaintext column if still populated (pre-encryption rows).
     COALESCE(private.decrypt_email_body(e.body_text_encrypted), NULLIF(e.body_text, ''))::text,
     e.snippet,
     e.received_at,
     e.forward_attempts;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.claim_forward_retries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_forward_retries(integer) TO service_role;

-- ─── Backfill: encrypt all existing body content ─────────────────────────
-- Re-runnable — WHERE clause excludes already-encrypted rows. UPDATEs
-- fire the trigger which also zeros the plaintext columns.
DO $$
DECLARE
  rec record;
  v_count integer := 0;
BEGIN
  IF private.email_body_key_id() IS NULL THEN
    RAISE NOTICE 'email_bodies_v1 key not provisioned. Backfill skipped.';
    RETURN;
  END IF;

  FOR rec IN
    SELECT id, body_text, body_html
      FROM public.emails
     WHERE body_text_encrypted IS NULL
       AND (
         (body_text IS NOT NULL AND length(body_text) > 0)
         OR
         (body_html IS NOT NULL AND length(body_html) > 0)
       )
  LOOP
    -- The UPDATE fires the BEFORE trigger which does the encryption +
    -- zeros the plaintext columns. Trigger only fires when body_text /
    -- body_html is in the UPDATE SET list, so we explicitly assign.
    UPDATE public.emails
       SET body_text = rec.body_text,
           body_html = rec.body_html
     WHERE id = rec.id;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'email-body backfill: encrypted % row(s).', v_count;
END $$;

-- ─── pubsub_events tag ───────────────────────────────────────────────────
-- For operator visibility of when this migration ran.
INSERT INTO public.pubsub_events (event_type, details)
VALUES ('migration', 'email body encryption enabled (email_bodies_v1 key)');
