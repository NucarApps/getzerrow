
-- Phase 2: dual-write — the encrypted RPCs now also populate plaintext
-- columns, so existing readers keep working while we migrate ingest
-- writes onto the RPCs. Plaintext columns get dropped in Phase 3 after
-- backfill.

-- ─── emails: upsert (main ingest entry point) ─────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_email_encrypted(
  p_user_id          uuid,
  p_gmail_account_id uuid,
  p_gmail_message_id text,
  p_thread_id        text,
  p_from_addr        text,
  p_from_name        text,
  p_to_addrs         text,
  p_cc               text,
  p_list_id          text,
  p_in_reply_to      text,
  p_subject          text,
  p_snippet          text,
  p_body_text        text,
  p_body_html        text,
  p_received_at      timestamptz,
  p_is_read          boolean,
  p_is_archived      boolean,
  p_has_attachment   boolean,
  p_raw_labels       text[],
  p_classified_by    text,
  p_processed_at     timestamptz,
  p_published_at_ms  bigint,
  p_key              text
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
    from_addr,
    from_name,     from_name_enc,
    to_addrs,      to_addrs_enc,
    cc,            cc_enc,
    list_id, in_reply_to,
    subject,       subject_enc,
    snippet,       snippet_enc,
    body_text,     body_text_enc,
    body_html,     body_html_enc,
    received_at, is_read, is_archived, has_attachment, raw_labels,
    folder_id, classified_by, processed_at, published_at_ms, key_version
  ) VALUES (
    p_user_id, p_gmail_account_id, p_gmail_message_id, p_thread_id,
    p_from_addr,
    p_from_name, private.encrypt_text(p_from_name, p_key),
    p_to_addrs,  private.encrypt_text(p_to_addrs,  p_key),
    p_cc,        private.encrypt_text(p_cc,        p_key),
    p_list_id, p_in_reply_to,
    p_subject,   private.encrypt_text(p_subject,   p_key),
    p_snippet,   private.encrypt_text(p_snippet,   p_key),
    p_body_text, private.encrypt_text(p_body_text, p_key),
    p_body_html, private.encrypt_text(p_body_html, p_key),
    p_received_at, COALESCE(p_is_read, false), COALESCE(p_is_archived, false),
    COALESCE(p_has_attachment, false), p_raw_labels,
    NULL, COALESCE(p_classified_by, 'pending'),
    p_processed_at, p_published_at_ms, 1
  )
  ON CONFLICT (gmail_message_id) DO UPDATE SET
    thread_id           = EXCLUDED.thread_id,
    from_addr           = EXCLUDED.from_addr,
    from_name           = EXCLUDED.from_name,
    from_name_enc       = EXCLUDED.from_name_enc,
    to_addrs            = EXCLUDED.to_addrs,
    to_addrs_enc        = EXCLUDED.to_addrs_enc,
    cc                  = EXCLUDED.cc,
    cc_enc              = EXCLUDED.cc_enc,
    list_id             = EXCLUDED.list_id,
    in_reply_to         = EXCLUDED.in_reply_to,
    subject             = EXCLUDED.subject,
    subject_enc         = EXCLUDED.subject_enc,
    snippet             = EXCLUDED.snippet,
    snippet_enc         = EXCLUDED.snippet_enc,
    body_text           = EXCLUDED.body_text,
    body_text_enc       = EXCLUDED.body_text_enc,
    body_html           = EXCLUDED.body_html,
    body_html_enc       = EXCLUDED.body_html_enc,
    received_at         = EXCLUDED.received_at,
    is_read             = EXCLUDED.is_read,
    is_archived         = EXCLUDED.is_archived,
    has_attachment      = EXCLUDED.has_attachment,
    raw_labels          = EXCLUDED.raw_labels,
    folder_id           = NULL,
    classified_by       = EXCLUDED.classified_by,
    processed_at        = EXCLUDED.processed_at,
    published_at_ms     = EXCLUDED.published_at_ms,
    key_version         = 1
  RETURNING id INTO v_id;

  v_tsv :=
       setweight(to_tsvector('simple', COALESCE(p_subject, '')),                 'A')
    || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),                 'B')
    || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 100000)), 'C');

  INSERT INTO public.email_search_index (email_id, user_id, tsv, updated_at)
  VALUES (v_id, p_user_id, v_tsv, now())
  ON CONFLICT (email_id) DO UPDATE
    SET tsv = EXCLUDED.tsv, user_id = EXCLUDED.user_id, updated_at = now();

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.upsert_email_encrypted(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean, boolean, boolean, text[], text, timestamptz, bigint, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_email_encrypted(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean, boolean, boolean, text[], text, timestamptz, bigint, text)
  TO service_role;

-- ─── emails: existing insert RPC now dual-writes ──────────────────────
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
    from_addr,
    from_name, from_name_enc,
    to_addrs,  to_addrs_enc,
    cc,        cc_enc,
    subject,   subject_enc,
    snippet,   snippet_enc,
    body_text, body_text_enc,
    body_html, body_html_enc,
    received_at, has_attachment, raw_labels, list_id, in_reply_to,
    published_at_ms, key_version
  ) VALUES (
    p_user_id, p_gmail_account_id, p_gmail_message_id, p_thread_id,
    p_from_addr,
    p_from_name, private.encrypt_text(p_from_name, p_key),
    p_to_addrs,  private.encrypt_text(p_to_addrs,  p_key),
    p_cc,        private.encrypt_text(p_cc,        p_key),
    p_subject,   private.encrypt_text(p_subject,   p_key),
    p_snippet,   private.encrypt_text(p_snippet,   p_key),
    p_body_text, private.encrypt_text(p_body_text, p_key),
    p_body_html, private.encrypt_text(p_body_html, p_key),
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
    SET tsv = EXCLUDED.tsv, user_id = EXCLUDED.user_id, updated_at = now();

  RETURN v_id;
END;
$$;

-- ─── emails: update RPC now dual-writes and also handles classify flags ─
DROP FUNCTION IF EXISTS public.update_email_encrypted(uuid, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.update_email_encrypted(
  p_email_id              uuid,
  p_subject               text,
  p_snippet               text,
  p_body_text             text,
  p_body_html             text,
  p_ai_summary            text,
  p_classification_reason text,
  p_from_name             text,
  p_to_addrs              text,
  p_folder_id             uuid,
  p_ai_confidence         real,
  p_classified_by         text,
  p_matched_filter_ids    uuid[],
  p_matched_folder_ids    uuid[],
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
    subject                   = CASE WHEN p_subject               IS NULL THEN subject               ELSE p_subject               END,
    subject_enc               = CASE WHEN p_subject               IS NULL THEN subject_enc           ELSE private.encrypt_text(p_subject,               p_key) END,
    snippet                   = CASE WHEN p_snippet               IS NULL THEN snippet               ELSE p_snippet               END,
    snippet_enc               = CASE WHEN p_snippet               IS NULL THEN snippet_enc           ELSE private.encrypt_text(p_snippet,               p_key) END,
    body_text                 = CASE WHEN p_body_text             IS NULL THEN body_text             ELSE p_body_text             END,
    body_text_enc             = CASE WHEN p_body_text             IS NULL THEN body_text_enc         ELSE private.encrypt_text(p_body_text,             p_key) END,
    body_html                 = CASE WHEN p_body_html             IS NULL THEN body_html             ELSE p_body_html             END,
    body_html_enc             = CASE WHEN p_body_html             IS NULL THEN body_html_enc         ELSE private.encrypt_text(p_body_html,             p_key) END,
    ai_summary                = CASE WHEN p_ai_summary            IS NULL THEN ai_summary            ELSE p_ai_summary            END,
    ai_summary_enc            = CASE WHEN p_ai_summary            IS NULL THEN ai_summary_enc        ELSE private.encrypt_text(p_ai_summary,            p_key) END,
    classification_reason     = CASE WHEN p_classification_reason IS NULL THEN classification_reason ELSE p_classification_reason END,
    classification_reason_enc = CASE WHEN p_classification_reason IS NULL THEN classification_reason_enc ELSE private.encrypt_text(p_classification_reason, p_key) END,
    from_name                 = CASE WHEN p_from_name             IS NULL THEN from_name             ELSE p_from_name             END,
    from_name_enc             = CASE WHEN p_from_name             IS NULL THEN from_name_enc         ELSE private.encrypt_text(p_from_name,             p_key) END,
    to_addrs                  = CASE WHEN p_to_addrs              IS NULL THEN to_addrs              ELSE p_to_addrs              END,
    to_addrs_enc              = CASE WHEN p_to_addrs              IS NULL THEN to_addrs_enc          ELSE private.encrypt_text(p_to_addrs,              p_key) END,
    folder_id                 = CASE WHEN p_folder_id             IS NULL THEN folder_id             ELSE p_folder_id             END,
    ai_confidence             = CASE WHEN p_ai_confidence         IS NULL THEN ai_confidence         ELSE p_ai_confidence         END,
    classified_by             = CASE WHEN p_classified_by         IS NULL THEN classified_by         ELSE p_classified_by         END,
    matched_filter_ids        = CASE WHEN p_matched_filter_ids    IS NULL THEN matched_filter_ids    ELSE p_matched_filter_ids    END,
    matched_folder_ids        = CASE WHEN p_matched_folder_ids    IS NULL THEN matched_folder_ids    ELSE p_matched_folder_ids    END
   WHERE id = p_email_id;

  IF p_subject IS NOT NULL OR p_snippet IS NOT NULL OR p_body_text IS NOT NULL THEN
    SELECT user_id, subject, snippet, body_text INTO v_user_id, v_subject, v_snippet, v_body
    FROM public.emails WHERE id = p_email_id;
    IF v_user_id IS NOT NULL THEN
      INSERT INTO public.email_search_index (email_id, user_id, tsv, updated_at)
      VALUES (
        p_email_id, v_user_id,
        setweight(to_tsvector('simple', COALESCE(v_subject, '')),                 'A')
        || setweight(to_tsvector('simple', COALESCE(v_snippet, '')),              'B')
        || setweight(to_tsvector('simple', left(COALESCE(v_body, ''), 100000)),   'C'),
        now()
      )
      ON CONFLICT (email_id) DO UPDATE
        SET tsv = EXCLUDED.tsv, updated_at = now();
    END IF;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.update_email_encrypted(uuid, text, text, text, text, text, text, text, text, uuid, real, text, uuid[], uuid[], text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_email_encrypted(uuid, text, text, text, text, text, text, text, text, uuid, real, text, uuid[], uuid[], text)
  TO service_role;

-- ─── reply_drafts: write actual plaintext too ─────────────────────────
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
  INSERT INTO public.reply_drafts (user_id, email_id, draft_text, draft_text_enc, key_version)
  VALUES (p_user_id, p_email_id, COALESCE(p_draft_text, ''), private.encrypt_text(p_draft_text, p_key), 1)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- ─── contacts: write both plaintext + encrypted ───────────────────────
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
    notes                    = CASE WHEN p_notes                IS NULL THEN notes                ELSE p_notes                END,
    notes_enc                = CASE WHEN p_notes                IS NULL THEN notes_enc            ELSE private.encrypt_text(p_notes,                p_key) END,
    relationship_summary     = CASE WHEN p_relationship_summary IS NULL THEN relationship_summary ELSE p_relationship_summary END,
    relationship_summary_enc = CASE WHEN p_relationship_summary IS NULL THEN relationship_summary_enc ELSE private.encrypt_text(p_relationship_summary, p_key) END,
    address_line1            = CASE WHEN p_address_line1        IS NULL THEN address_line1        ELSE p_address_line1        END,
    address_line1_enc        = CASE WHEN p_address_line1        IS NULL THEN address_line1_enc    ELSE private.encrypt_text(p_address_line1,        p_key) END,
    address_line2            = CASE WHEN p_address_line2        IS NULL THEN address_line2        ELSE p_address_line2        END,
    address_line2_enc        = CASE WHEN p_address_line2        IS NULL THEN address_line2_enc    ELSE private.encrypt_text(p_address_line2,        p_key) END,
    phone                    = CASE WHEN p_phone                IS NULL THEN phone                ELSE p_phone                END,
    phone_enc                = CASE WHEN p_phone                IS NULL THEN phone_enc            ELSE private.encrypt_text(p_phone,                p_key) END,
    updated_at               = now()
   WHERE id = p_contact_id;
END;
$$;

-- ─── folder_examples: dual-write ──────────────────────────────────────
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
    from_addr,
    subject, subject_enc,
    snippet, snippet_enc,
    source, key_version
  ) VALUES (
    p_user_id, p_gmail_account_id, p_folder_id, p_gmail_message_id,
    p_from_addr,
    p_subject, private.encrypt_text(p_subject, p_key),
    p_snippet, private.encrypt_text(p_snippet, p_key),
    COALESCE(p_source, 'seed'), 1
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
