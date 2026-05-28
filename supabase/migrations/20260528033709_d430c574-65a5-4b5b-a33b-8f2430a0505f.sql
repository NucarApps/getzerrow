-- ============================================================================
-- Phase 1: at-rest encryption foundation (pgcrypto + key-passing RPCs).
--
-- Mirrors the existing OAuth-token pattern (gmail_accounts.*_enc + the
-- upsert/get/set_gmail_oauth_tokens RPCs). App code will be refactored
-- in a follow-up phase to call the new RPCs; this migration only adds
-- structure and helpers, so nothing breaks on apply.
-- ============================================================================

-- ─── Generic AEAD helpers using pgcrypto + caller-supplied key ───────────
-- pgp_sym_encrypt is non-deterministic (random IV per call), AEAD, and
-- already used by the OAuth-token helpers, so there is no new dependency.

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.encrypt_text(p_plaintext text, p_key text)
  RETURNS bytea
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, extensions
AS $$
BEGIN
  IF p_plaintext IS NULL OR length(p_plaintext) = 0 THEN
    RETURN NULL;
  END IF;
  IF p_key IS NULL OR length(p_key) = 0 THEN
    RAISE EXCEPTION 'encryption key required';
  END IF;
  RETURN extensions.pgp_sym_encrypt(p_plaintext, p_key);
END;
$$;
REVOKE ALL ON FUNCTION private.encrypt_text(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.encrypt_text(text, text) TO service_role;

CREATE OR REPLACE FUNCTION private.decrypt_text(p_ciphertext bytea, p_key text)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, extensions
AS $$
BEGIN
  IF p_ciphertext IS NULL THEN RETURN NULL; END IF;
  IF p_key IS NULL OR length(p_key) = 0 THEN
    RAISE EXCEPTION 'encryption key required';
  END IF;
  RETURN extensions.pgp_sym_decrypt(p_ciphertext, p_key);
EXCEPTION WHEN OTHERS THEN
  -- Wrong key / corrupted ciphertext → NULL, never crash a SELECT.
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION private.decrypt_text(bytea, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.decrypt_text(bytea, text) TO service_role;

-- ─── emails ──────────────────────────────────────────────────────────────

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS subject_enc               bytea,
  ADD COLUMN IF NOT EXISTS snippet_enc               bytea,
  ADD COLUMN IF NOT EXISTS from_name_enc             bytea,
  ADD COLUMN IF NOT EXISTS to_addrs_enc              bytea,
  ADD COLUMN IF NOT EXISTS cc_enc                    bytea,
  ADD COLUMN IF NOT EXISTS ai_summary_enc            bytea,
  ADD COLUMN IF NOT EXISTS classification_reason_enc bytea,
  ADD COLUMN IF NOT EXISTS body_text_enc             bytea,
  ADD COLUMN IF NOT EXISTS body_html_enc             bytea,
  ADD COLUMN IF NOT EXISTS key_version               smallint NOT NULL DEFAULT 1;

-- Insert a fresh email row with all sensitive fields encrypted.
-- Returns the new id. App code will be moved to call this RPC instead
-- of supabaseAdmin.from('emails').insert(...).
CREATE OR REPLACE FUNCTION public.insert_email_encrypted(
  p_user_id               uuid,
  p_gmail_account_id      uuid,
  p_gmail_message_id      text,
  p_thread_id             text,
  p_from_addr             text,
  p_from_name             text,
  p_to_addrs              text,
  p_cc                    text,
  p_subject               text,
  p_snippet               text,
  p_body_text             text,
  p_body_html             text,
  p_received_at           timestamptz,
  p_has_attachment        boolean,
  p_raw_labels            text[],
  p_list_id               text,
  p_in_reply_to           text,
  p_published_at_ms       bigint,
  p_key                   text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
DECLARE
  v_id  uuid;
  v_tsv tsvector;
BEGIN
  INSERT INTO public.emails (
    user_id, gmail_account_id, gmail_message_id, thread_id,
    from_addr, from_name_enc, to_addrs_enc, cc_enc,
    subject_enc, snippet_enc, body_text_enc, body_html_enc,
    received_at, has_attachment, raw_labels, list_id, in_reply_to,
    published_at_ms, key_version
  ) VALUES (
    p_user_id, p_gmail_account_id, p_gmail_message_id, p_thread_id,
    p_from_addr,
    private.encrypt_text(p_from_name, p_key),
    private.encrypt_text(p_to_addrs,  p_key),
    private.encrypt_text(p_cc,        p_key),
    private.encrypt_text(p_subject,   p_key),
    private.encrypt_text(p_snippet,   p_key),
    private.encrypt_text(p_body_text, p_key),
    private.encrypt_text(p_body_html, p_key),
    p_received_at, COALESCE(p_has_attachment, false), p_raw_labels,
    p_list_id, p_in_reply_to, p_published_at_ms, 1
  )
  RETURNING id INTO v_id;

  v_tsv :=
       setweight(to_tsvector('simple', COALESCE(p_subject, '')),                 'A')
    || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),                 'B')
    || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 100000)), 'C');

  INSERT INTO public.email_search_index (email_id, user_id, tsv, updated_at)
  VALUES (v_id, p_user_id, v_tsv, now())
  ON CONFLICT (email_id) DO UPDATE
    SET tsv        = EXCLUDED.tsv,
        user_id    = EXCLUDED.user_id,
        updated_at = now();

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.insert_email_encrypted(uuid, uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean, text[], text, text, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_email_encrypted(uuid, uuid, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean, text[], text, text, bigint, text)
  TO service_role;

-- Patch (subject/snippet/body/summary/etc) an existing email. Pass NULL
-- to leave a field unchanged; pass empty string to clear it.
CREATE OR REPLACE FUNCTION public.update_email_encrypted(
  p_email_id              uuid,
  p_subject               text,
  p_snippet               text,
  p_body_text             text,
  p_body_html             text,
  p_ai_summary            text,
  p_classification_reason text,
  p_key                   text
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
DECLARE
  v_user_id uuid;
  v_subject text;
  v_snippet text;
  v_body    text;
BEGIN
  UPDATE public.emails SET
    subject_enc               = CASE WHEN p_subject               IS NULL THEN subject_enc               ELSE private.encrypt_text(p_subject,               p_key) END,
    snippet_enc               = CASE WHEN p_snippet               IS NULL THEN snippet_enc               ELSE private.encrypt_text(p_snippet,               p_key) END,
    body_text_enc             = CASE WHEN p_body_text             IS NULL THEN body_text_enc             ELSE private.encrypt_text(p_body_text,             p_key) END,
    body_html_enc             = CASE WHEN p_body_html             IS NULL THEN body_html_enc             ELSE private.encrypt_text(p_body_html,             p_key) END,
    ai_summary_enc            = CASE WHEN p_ai_summary            IS NULL THEN ai_summary_enc            ELSE private.encrypt_text(p_ai_summary,            p_key) END,
    classification_reason_enc = CASE WHEN p_classification_reason IS NULL THEN classification_reason_enc ELSE private.encrypt_text(p_classification_reason, p_key) END
   WHERE id = p_email_id;

  -- Refresh the search index whenever subject/snippet/body changed.
  IF p_subject IS NOT NULL OR p_snippet IS NOT NULL OR p_body_text IS NOT NULL THEN
    SELECT user_id INTO v_user_id FROM public.emails WHERE id = p_email_id;
    IF v_user_id IS NOT NULL THEN
      v_subject := COALESCE(p_subject,   private.decrypt_text((SELECT subject_enc   FROM public.emails WHERE id = p_email_id), p_key), '');
      v_snippet := COALESCE(p_snippet,   private.decrypt_text((SELECT snippet_enc   FROM public.emails WHERE id = p_email_id), p_key), '');
      v_body    := COALESCE(p_body_text, private.decrypt_text((SELECT body_text_enc FROM public.emails WHERE id = p_email_id), p_key), '');
      INSERT INTO public.email_search_index (email_id, user_id, tsv, updated_at)
      VALUES (
        p_email_id, v_user_id,
        setweight(to_tsvector('simple', v_subject),                 'A')
        || setweight(to_tsvector('simple', v_snippet),              'B')
        || setweight(to_tsvector('simple', left(v_body, 100000)),   'C'),
        now()
      )
      ON CONFLICT (email_id) DO UPDATE
        SET tsv        = EXCLUDED.tsv,
            updated_at = now();
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.update_email_encrypted(uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_email_encrypted(uuid, text, text, text, text, text, text, text) TO service_role;

-- Bulk-decrypt for list/detail views.
CREATE OR REPLACE FUNCTION public.get_emails_decrypted(p_ids uuid[], p_key text)
  RETURNS TABLE(
    id uuid, user_id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text,
    from_addr text, from_name text, to_addrs text, cc text,
    subject text, snippet text, body_text text, body_html text, ai_summary text,
    classification_reason text, classified_by text, ai_confidence real,
    received_at timestamptz, is_read boolean, is_archived boolean, has_attachment boolean,
    raw_labels text[], folder_id uuid, matched_filter_ids uuid[], matched_folder_ids uuid[],
    snoozed_until timestamptz, forwarded_to text, forwarded_at timestamptz,
    list_id text, in_reply_to text, published_at_ms bigint,
    processed_at timestamptz, created_at timestamptz
  )
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
  SELECT
    e.id, e.user_id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
    e.from_addr,
    COALESCE(private.decrypt_text(e.from_name_enc, p_key), e.from_name),
    COALESCE(private.decrypt_text(e.to_addrs_enc,  p_key), e.to_addrs),
    COALESCE(private.decrypt_text(e.cc_enc,        p_key), e.cc),
    COALESCE(private.decrypt_text(e.subject_enc,   p_key), e.subject),
    COALESCE(private.decrypt_text(e.snippet_enc,   p_key), e.snippet),
    COALESCE(private.decrypt_text(e.body_text_enc, p_key), e.body_text),
    COALESCE(private.decrypt_text(e.body_html_enc, p_key), e.body_html),
    COALESCE(private.decrypt_text(e.ai_summary_enc, p_key), e.ai_summary),
    COALESCE(private.decrypt_text(e.classification_reason_enc, p_key), e.classification_reason),
    e.classified_by, e.ai_confidence,
    e.received_at, e.is_read, e.is_archived, e.has_attachment,
    e.raw_labels, e.folder_id, e.matched_filter_ids, e.matched_folder_ids,
    e.snoozed_until, e.forwarded_to, e.forwarded_at,
    e.list_id, e.in_reply_to, e.published_at_ms,
    e.processed_at, e.created_at
  FROM public.emails e
  WHERE e.id = ANY(p_ids);
$$;
REVOKE ALL ON FUNCTION public.get_emails_decrypted(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_emails_decrypted(uuid[], text) TO service_role;

-- ─── email_search_index ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.email_search_index (
  email_id   uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  tsv        tsvector NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_search_index_tsv_idx     ON public.email_search_index USING GIN (tsv);
CREATE INDEX IF NOT EXISTS email_search_index_user_id_idx ON public.email_search_index (user_id);

GRANT SELECT ON public.email_search_index TO authenticated;
GRANT ALL    ON public.email_search_index TO service_role;

ALTER TABLE public.email_search_index ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users view own search index" ON public.email_search_index;
CREATE POLICY "Users view own search index"
  ON public.email_search_index
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Run a websearch-style query against a user's search index and return
-- decrypted rows. Single round-trip from the server function.
CREATE OR REPLACE FUNCTION public.search_emails(
  p_user_id uuid,
  p_query   text,
  p_limit   integer,
  p_offset  integer,
  p_key     text
) RETURNS TABLE(
  id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text,
  from_addr text, from_name text, subject text, snippet text,
  received_at timestamptz, is_read boolean, is_archived boolean,
  folder_id uuid, rank real
)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
  SELECT
    e.id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
    e.from_addr,
    COALESCE(private.decrypt_text(e.from_name_enc, p_key), e.from_name),
    COALESCE(private.decrypt_text(e.subject_enc,   p_key), e.subject),
    COALESCE(private.decrypt_text(e.snippet_enc,   p_key), e.snippet),
    e.received_at, e.is_read, e.is_archived, e.folder_id,
    ts_rank(si.tsv, websearch_to_tsquery('simple', p_query)) AS rank
  FROM public.email_search_index si
  JOIN public.emails e ON e.id = si.email_id
  WHERE si.user_id = p_user_id
    AND si.tsv @@ websearch_to_tsquery('simple', p_query)
  ORDER BY rank DESC, e.received_at DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;
REVOKE ALL ON FUNCTION public.search_emails(uuid, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_emails(uuid, text, integer, integer, text) TO service_role;

-- ─── reply_drafts ────────────────────────────────────────────────────────

ALTER TABLE public.reply_drafts
  ADD COLUMN IF NOT EXISTS draft_text_enc bytea,
  ADD COLUMN IF NOT EXISTS key_version    smallint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.set_reply_draft_encrypted(
  p_user_id     uuid,
  p_email_id    uuid,
  p_draft_text  text,
  p_key         text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.reply_drafts (user_id, email_id, draft_text_enc, draft_text, key_version)
  VALUES (p_user_id, p_email_id, private.encrypt_text(p_draft_text, p_key), '', 1)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_reply_draft_encrypted(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_reply_draft_encrypted(uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_reply_draft_decrypted(p_email_id uuid, p_key text)
  RETURNS TABLE(id uuid, user_id uuid, email_id uuid, draft_text text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
  SELECT rd.id, rd.user_id, rd.email_id,
         COALESCE(private.decrypt_text(rd.draft_text_enc, p_key), rd.draft_text),
         rd.created_at
  FROM public.reply_drafts rd
  WHERE rd.email_id = p_email_id
  ORDER BY rd.created_at DESC
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_reply_draft_decrypted(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_reply_draft_decrypted(uuid, text) TO service_role;

-- ─── contacts ────────────────────────────────────────────────────────────

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS notes_enc                bytea,
  ADD COLUMN IF NOT EXISTS relationship_summary_enc bytea,
  ADD COLUMN IF NOT EXISTS address_line1_enc        bytea,
  ADD COLUMN IF NOT EXISTS address_line2_enc        bytea,
  ADD COLUMN IF NOT EXISTS phone_enc                bytea,
  ADD COLUMN IF NOT EXISTS key_version              smallint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.set_contact_encrypted_fields(
  p_contact_id            uuid,
  p_notes                 text,
  p_relationship_summary  text,
  p_address_line1         text,
  p_address_line2         text,
  p_phone                 text,
  p_key                   text
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
BEGIN
  UPDATE public.contacts SET
    notes_enc                = CASE WHEN p_notes                IS NULL THEN notes_enc                ELSE private.encrypt_text(p_notes,                p_key) END,
    relationship_summary_enc = CASE WHEN p_relationship_summary IS NULL THEN relationship_summary_enc ELSE private.encrypt_text(p_relationship_summary, p_key) END,
    address_line1_enc        = CASE WHEN p_address_line1        IS NULL THEN address_line1_enc        ELSE private.encrypt_text(p_address_line1,        p_key) END,
    address_line2_enc        = CASE WHEN p_address_line2        IS NULL THEN address_line2_enc        ELSE private.encrypt_text(p_address_line2,        p_key) END,
    phone_enc                = CASE WHEN p_phone                IS NULL THEN phone_enc                ELSE private.encrypt_text(p_phone,                p_key) END,
    updated_at               = now()
   WHERE id = p_contact_id;
END;
$$;
REVOKE ALL ON FUNCTION public.set_contact_encrypted_fields(uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_contact_encrypted_fields(uuid, text, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_contact_decrypted(p_contact_id uuid, p_key text)
  RETURNS TABLE(
    id uuid, user_id uuid, email text, name text, avatar_url text,
    title text, company text, phone text, website text, card_image_url text,
    address_line1 text, address_line2 text, city text, region text,
    postal_code text, country text, linkedin text, twitter text,
    relationship_summary text, summary_generated_at timestamptz,
    notes text, source text, enriched_at timestamptz,
    created_at timestamptz, updated_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
  SELECT
    c.id, c.user_id, c.email, c.name, c.avatar_url, c.title, c.company,
    COALESCE(private.decrypt_text(c.phone_enc, p_key), c.phone),
    c.website, c.card_image_url,
    COALESCE(private.decrypt_text(c.address_line1_enc, p_key), c.address_line1),
    COALESCE(private.decrypt_text(c.address_line2_enc, p_key), c.address_line2),
    c.city, c.region, c.postal_code, c.country, c.linkedin, c.twitter,
    COALESCE(private.decrypt_text(c.relationship_summary_enc, p_key), c.relationship_summary),
    c.summary_generated_at,
    COALESCE(private.decrypt_text(c.notes_enc, p_key), c.notes),
    c.source, c.enriched_at, c.created_at, c.updated_at
  FROM public.contacts c
  WHERE c.id = p_contact_id;
$$;
REVOKE ALL ON FUNCTION public.get_contact_decrypted(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_contact_decrypted(uuid, text) TO service_role;

-- ─── folder_examples ────────────────────────────────────────────────────

ALTER TABLE public.folder_examples
  ADD COLUMN IF NOT EXISTS subject_enc bytea,
  ADD COLUMN IF NOT EXISTS snippet_enc bytea,
  ADD COLUMN IF NOT EXISTS key_version smallint NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.insert_folder_example_encrypted(
  p_user_id          uuid,
  p_gmail_account_id uuid,
  p_folder_id        uuid,
  p_gmail_message_id text,
  p_from_addr        text,
  p_subject          text,
  p_snippet          text,
  p_source           text,
  p_key              text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.folder_examples (
    user_id, gmail_account_id, folder_id, gmail_message_id,
    from_addr, subject_enc, snippet_enc, source, key_version
  ) VALUES (
    p_user_id, p_gmail_account_id, p_folder_id, p_gmail_message_id,
    p_from_addr,
    private.encrypt_text(p_subject, p_key),
    private.encrypt_text(p_snippet, p_key),
    COALESCE(p_source, 'seed'), 1
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.insert_folder_example_encrypted(uuid, uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_folder_example_encrypted(uuid, uuid, uuid, text, text, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_folder_examples_decrypted(p_folder_id uuid, p_key text)
  RETURNS TABLE(
    id uuid, user_id uuid, gmail_account_id uuid, folder_id uuid,
    gmail_message_id text, from_addr text, subject text, snippet text,
    source text, created_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, private, extensions
AS $$
  SELECT
    fe.id, fe.user_id, fe.gmail_account_id, fe.folder_id,
    fe.gmail_message_id, fe.from_addr,
    COALESCE(private.decrypt_text(fe.subject_enc, p_key), fe.subject),
    COALESCE(private.decrypt_text(fe.snippet_enc, p_key), fe.snippet),
    fe.source, fe.created_at
  FROM public.folder_examples fe
  WHERE fe.folder_id = p_folder_id
  ORDER BY fe.created_at DESC;
$$;
REVOKE ALL ON FUNCTION public.get_folder_examples_decrypted(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_folder_examples_decrypted(uuid, text) TO service_role;
