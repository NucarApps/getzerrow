-- Detach affected tables from the realtime publication so column drops succeed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN ALTER PUBLICATION supabase_realtime DROP TABLE public.emails;          EXCEPTION WHEN undefined_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime DROP TABLE public.contacts;        EXCEPTION WHEN undefined_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime DROP TABLE public.reply_drafts;    EXCEPTION WHEN undefined_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime DROP TABLE public.folder_examples; EXCEPTION WHEN undefined_object THEN NULL; END;
  END IF;
END $$;

DROP VIEW IF EXISTS public.emails_decrypted;

CREATE OR REPLACE FUNCTION public.upsert_email_encrypted(
  p_user_id uuid, p_gmail_account_id uuid, p_gmail_message_id text, p_thread_id text,
  p_from_addr text, p_from_name text, p_to_addrs text, p_cc text,
  p_list_id text, p_in_reply_to text,
  p_subject text, p_snippet text, p_body_text text, p_body_html text,
  p_received_at timestamptz, p_is_read boolean, p_is_archived boolean,
  p_has_attachment boolean, p_raw_labels text[],
  p_classified_by text, p_processed_at timestamptz, p_published_at_ms bigint,
  p_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_id uuid; v_tsv tsvector;
BEGIN
  INSERT INTO public.emails (
    user_id, gmail_account_id, gmail_message_id, thread_id,
    from_addr, from_name_enc, to_addrs_enc, cc_enc,
    list_id, in_reply_to,
    subject_enc, snippet_enc, body_text_enc, body_html_enc,
    received_at, is_read, is_archived, has_attachment, raw_labels,
    folder_id, classified_by, processed_at, published_at_ms, key_version
  ) VALUES (
    p_user_id, p_gmail_account_id, p_gmail_message_id, p_thread_id,
    p_from_addr,
    private.encrypt_text(p_from_name, p_key),
    private.encrypt_text(p_to_addrs,  p_key),
    private.encrypt_text(p_cc,        p_key),
    p_list_id, p_in_reply_to,
    private.encrypt_text(p_subject,   p_key),
    private.encrypt_text(p_snippet,   p_key),
    private.encrypt_text(p_body_text, p_key),
    private.encrypt_text(p_body_html, p_key),
    p_received_at, COALESCE(p_is_read, false), COALESCE(p_is_archived, false),
    COALESCE(p_has_attachment, false), p_raw_labels,
    NULL, COALESCE(p_classified_by, 'pending'),
    p_processed_at, p_published_at_ms, 1
  )
  ON CONFLICT (gmail_message_id) DO UPDATE SET
    thread_id       = EXCLUDED.thread_id,
    from_addr       = EXCLUDED.from_addr,
    from_name_enc   = EXCLUDED.from_name_enc,
    to_addrs_enc    = EXCLUDED.to_addrs_enc,
    cc_enc          = EXCLUDED.cc_enc,
    list_id         = EXCLUDED.list_id,
    in_reply_to     = EXCLUDED.in_reply_to,
    subject_enc     = EXCLUDED.subject_enc,
    snippet_enc     = EXCLUDED.snippet_enc,
    body_text_enc   = EXCLUDED.body_text_enc,
    body_html_enc   = EXCLUDED.body_html_enc,
    received_at     = EXCLUDED.received_at,
    is_read         = EXCLUDED.is_read,
    is_archived     = EXCLUDED.is_archived,
    has_attachment  = EXCLUDED.has_attachment,
    raw_labels      = EXCLUDED.raw_labels,
    folder_id       = NULL,
    classified_by   = EXCLUDED.classified_by,
    processed_at    = EXCLUDED.processed_at,
    published_at_ms = EXCLUDED.published_at_ms,
    key_version     = 1
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

CREATE OR REPLACE FUNCTION public.insert_email_encrypted(
  p_user_id uuid, p_gmail_account_id uuid, p_gmail_message_id text, p_thread_id text,
  p_from_addr text, p_from_name text, p_to_addrs text, p_cc text,
  p_subject text, p_snippet text, p_body_text text, p_body_html text,
  p_received_at timestamptz, p_has_attachment boolean, p_raw_labels text[],
  p_list_id text, p_in_reply_to text, p_published_at_ms bigint, p_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_id uuid; v_tsv tsvector;
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
    SET tsv = EXCLUDED.tsv, user_id = EXCLUDED.user_id, updated_at = now();

  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_email_encrypted(
  p_email_id uuid, p_subject text, p_snippet text, p_body_text text, p_body_html text,
  p_ai_summary text, p_classification_reason text, p_from_name text, p_to_addrs text,
  p_folder_id uuid, p_ai_confidence real, p_classified_by text,
  p_matched_filter_ids uuid[], p_matched_folder_ids uuid[], p_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_user_id uuid; v_subject text; v_snippet text; v_body text;
BEGIN
  UPDATE public.emails SET
    subject_enc               = CASE WHEN p_subject               IS NULL THEN subject_enc               ELSE private.encrypt_text(p_subject,               p_key) END,
    snippet_enc               = CASE WHEN p_snippet               IS NULL THEN snippet_enc               ELSE private.encrypt_text(p_snippet,               p_key) END,
    body_text_enc             = CASE WHEN p_body_text             IS NULL THEN body_text_enc             ELSE private.encrypt_text(p_body_text,             p_key) END,
    body_html_enc             = CASE WHEN p_body_html             IS NULL THEN body_html_enc             ELSE private.encrypt_text(p_body_html,             p_key) END,
    ai_summary_enc            = CASE WHEN p_ai_summary            IS NULL THEN ai_summary_enc            ELSE private.encrypt_text(p_ai_summary,            p_key) END,
    classification_reason_enc = CASE WHEN p_classification_reason IS NULL THEN classification_reason_enc ELSE private.encrypt_text(p_classification_reason, p_key) END,
    from_name_enc             = CASE WHEN p_from_name             IS NULL THEN from_name_enc             ELSE private.encrypt_text(p_from_name,             p_key) END,
    to_addrs_enc              = CASE WHEN p_to_addrs              IS NULL THEN to_addrs_enc              ELSE private.encrypt_text(p_to_addrs,              p_key) END,
    folder_id                 = CASE WHEN p_folder_id             IS NULL THEN folder_id                 ELSE p_folder_id          END,
    ai_confidence             = CASE WHEN p_ai_confidence         IS NULL THEN ai_confidence             ELSE p_ai_confidence      END,
    classified_by             = CASE WHEN p_classified_by         IS NULL THEN classified_by             ELSE p_classified_by      END,
    matched_filter_ids        = CASE WHEN p_matched_filter_ids    IS NULL THEN matched_filter_ids        ELSE p_matched_filter_ids END,
    matched_folder_ids        = CASE WHEN p_matched_folder_ids    IS NULL THEN matched_folder_ids        ELSE p_matched_folder_ids END
   WHERE id = p_email_id;

  IF p_subject IS NOT NULL OR p_snippet IS NOT NULL OR p_body_text IS NOT NULL THEN
    SELECT user_id INTO v_user_id FROM public.emails WHERE id = p_email_id;
    v_subject := p_subject;
    v_snippet := p_snippet;
    v_body    := p_body_text;
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

CREATE OR REPLACE FUNCTION public.set_reply_draft_encrypted(
  p_user_id uuid, p_email_id uuid, p_draft_text text, p_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.reply_drafts (user_id, email_id, draft_text_enc, key_version)
  VALUES (p_user_id, p_email_id, private.encrypt_text(p_draft_text, p_key), 1)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

ALTER TABLE public.emails
  DROP COLUMN body_text,
  DROP COLUMN body_html,
  DROP COLUMN ai_summary,
  DROP COLUMN classification_reason,
  DROP COLUMN from_name,
  DROP COLUMN to_addrs,
  DROP COLUMN cc,
  DROP COLUMN subject,
  DROP COLUMN snippet;

ALTER TABLE public.reply_drafts DROP COLUMN draft_text;

ALTER TABLE public.contacts
  DROP COLUMN notes,
  DROP COLUMN relationship_summary,
  DROP COLUMN address_line1,
  DROP COLUMN address_line2,
  DROP COLUMN phone;

ALTER TABLE public.folder_examples
  DROP COLUMN subject,
  DROP COLUMN snippet;

CREATE OR REPLACE FUNCTION public.get_emails_decrypted(p_ids uuid[], p_key text)
RETURNS TABLE(
  id uuid, user_id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text,
  from_addr text, from_name text, to_addrs text, cc text, subject text, snippet text,
  body_text text, body_html text, ai_summary text, classification_reason text,
  classified_by text, ai_confidence real, received_at timestamptz,
  is_read boolean, is_archived boolean, has_attachment boolean,
  raw_labels text[], folder_id uuid, matched_filter_ids uuid[], matched_folder_ids uuid[],
  snoozed_until timestamptz, forwarded_to text, forwarded_at timestamptz,
  list_id text, in_reply_to text, published_at_ms bigint,
  processed_at timestamptz, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
  SELECT
    e.id, e.user_id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
    e.from_addr,
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.to_addrs_enc,  p_key),
    private.decrypt_text(e.cc_enc,        p_key),
    private.decrypt_text(e.subject_enc,   p_key),
    private.decrypt_text(e.snippet_enc,   p_key),
    private.decrypt_text(e.body_text_enc, p_key),
    private.decrypt_text(e.body_html_enc, p_key),
    private.decrypt_text(e.ai_summary_enc, p_key),
    private.decrypt_text(e.classification_reason_enc, p_key),
    e.classified_by, e.ai_confidence,
    e.received_at, e.is_read, e.is_archived, e.has_attachment,
    e.raw_labels, e.folder_id, e.matched_filter_ids, e.matched_folder_ids,
    e.snoozed_until, e.forwarded_to, e.forwarded_at,
    e.list_id, e.in_reply_to, e.published_at_ms,
    e.processed_at, e.created_at
  FROM public.emails e
  WHERE e.id = ANY(p_ids);
$$;

CREATE OR REPLACE FUNCTION public.get_contact_decrypted(p_contact_id uuid, p_key text)
RETURNS TABLE(
  id uuid, user_id uuid, email text, name text, avatar_url text, title text, company text,
  phone text, website text, card_image_url text,
  address_line1 text, address_line2 text, city text, region text, postal_code text, country text,
  linkedin text, twitter text, relationship_summary text, summary_generated_at timestamptz,
  notes text, source text, enriched_at timestamptz, created_at timestamptz, updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
  SELECT
    c.id, c.user_id, c.email, c.name, c.avatar_url, c.title, c.company,
    private.decrypt_text(c.phone_enc, p_key),
    c.website, c.card_image_url,
    private.decrypt_text(c.address_line1_enc, p_key),
    private.decrypt_text(c.address_line2_enc, p_key),
    c.city, c.region, c.postal_code, c.country, c.linkedin, c.twitter,
    private.decrypt_text(c.relationship_summary_enc, p_key),
    c.summary_generated_at,
    private.decrypt_text(c.notes_enc, p_key),
    c.source, c.enriched_at, c.created_at, c.updated_at
  FROM public.contacts c
  WHERE c.id = p_contact_id;
$$;

CREATE OR REPLACE FUNCTION public.get_reply_draft_decrypted(p_email_id uuid, p_key text)
RETURNS TABLE(id uuid, user_id uuid, email_id uuid, draft_text text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
  SELECT rd.id, rd.user_id, rd.email_id,
         private.decrypt_text(rd.draft_text_enc, p_key),
         rd.created_at
  FROM public.reply_drafts rd
  WHERE rd.email_id = p_email_id
  ORDER BY rd.created_at DESC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_folder_examples_decrypted(p_folder_id uuid, p_key text)
RETURNS TABLE(id uuid, user_id uuid, gmail_account_id uuid, folder_id uuid,
              gmail_message_id text, from_addr text, subject text, snippet text,
              source text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
  SELECT
    fe.id, fe.user_id, fe.gmail_account_id, fe.folder_id,
    fe.gmail_message_id, fe.from_addr,
    private.decrypt_text(fe.subject_enc, p_key),
    private.decrypt_text(fe.snippet_enc, p_key),
    fe.source, fe.created_at
  FROM public.folder_examples fe
  WHERE fe.folder_id = p_folder_id
  ORDER BY fe.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.search_emails(
  p_user_id uuid, p_query text, p_limit integer, p_offset integer, p_key text
)
RETURNS TABLE(id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text,
              from_addr text, from_name text, subject text, snippet text,
              received_at timestamptz, is_read boolean, is_archived boolean,
              folder_id uuid, rank real)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
  SELECT
    e.id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
    e.from_addr,
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.subject_enc,   p_key),
    private.decrypt_text(e.snippet_enc,   p_key),
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

DROP FUNCTION IF EXISTS public.claim_forward_retries(integer);
DROP FUNCTION IF EXISTS public.backfill_emails_encryption(integer, text);
DROP FUNCTION IF EXISTS public.backfill_contacts_encryption(integer, text);
DROP FUNCTION IF EXISTS public.backfill_reply_drafts_encryption(integer, text);
DROP FUNCTION IF EXISTS public.backfill_folder_examples_encryption(integer, text);

-- Re-attach tables to the realtime publication.
ALTER PUBLICATION supabase_realtime ADD TABLE public.emails;
ALTER PUBLICATION supabase_realtime ADD TABLE public.contacts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.reply_drafts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.folder_examples;
