CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS email_search_index_user_tsv_idx
  ON public.email_search_index USING GIN (user_id, tsv);

ALTER TABLE public.email_search_index
  ADD COLUMN IF NOT EXISTS has_sender boolean NOT NULL DEFAULT false;

DROP FUNCTION IF EXISTS public.search_emails(uuid, text, integer, integer, text);
DROP FUNCTION IF EXISTS public.search_emails(uuid, text, integer, integer, text, uuid);

CREATE OR REPLACE FUNCTION public.search_emails(
  p_user_id uuid,
  p_query text,
  p_limit integer,
  p_offset integer,
  p_key text,
  p_account_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text,
  from_addr text, from_name text, subject text, snippet text,
  received_at timestamptz, is_read boolean, is_archived boolean,
  folder_id uuid, rank real
)
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
    AND (p_account_id IS NULL OR e.gmail_account_id = p_account_id)
    AND e.classified_by NOT IN ('pending', 'pending_ai')
  ORDER BY rank DESC, e.received_at DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
$$;

REVOKE ALL ON FUNCTION public.search_emails(uuid, text, integer, integer, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_emails(uuid, text, integer, integer, text, uuid) FROM anon, authenticated;

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
       setweight(to_tsvector('simple', COALESCE(p_from_addr, '')),               'A')
    || setweight(to_tsvector('simple', COALESCE(p_from_name, '')),               'A')
    || setweight(to_tsvector('simple', COALESCE(p_subject, '')),                 'A')
    || setweight(to_tsvector('simple', COALESCE(p_to_addrs, '')),                'B')
    || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),                 'B')
    || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 100000)), 'C');

  INSERT INTO public.email_search_index (email_id, user_id, tsv, has_sender, updated_at)
  VALUES (v_id, p_user_id, v_tsv, true, now())
  ON CONFLICT (email_id) DO UPDATE
    SET tsv = EXCLUDED.tsv, user_id = EXCLUDED.user_id,
        has_sender = true, updated_at = now();

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
DECLARE v_user_id uuid; v_from_addr text;
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

  IF p_subject IS NOT NULL OR p_snippet IS NOT NULL OR p_body_text IS NOT NULL
     OR p_from_name IS NOT NULL OR p_to_addrs IS NOT NULL THEN
    SELECT user_id, from_addr INTO v_user_id, v_from_addr
      FROM public.emails WHERE id = p_email_id;
    IF v_user_id IS NOT NULL THEN
      INSERT INTO public.email_search_index (email_id, user_id, tsv, has_sender, updated_at)
      VALUES (
        p_email_id, v_user_id,
        setweight(to_tsvector('simple', COALESCE(v_from_addr, '')),                'A')
        || setweight(to_tsvector('simple', COALESCE(p_from_name, '')),            'A')
        || setweight(to_tsvector('simple', COALESCE(p_subject, '')),             'A')
        || setweight(to_tsvector('simple', COALESCE(p_to_addrs, '')),            'B')
        || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),             'B')
        || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 100000)), 'C'),
        true, now()
      )
      ON CONFLICT (email_id) DO UPDATE
        SET tsv = EXCLUDED.tsv, has_sender = true, updated_at = now();
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.reindex_email_search_sender(
  p_batch_limit int, p_key text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT si.email_id
      FROM public.email_search_index si
      JOIN public.emails e ON e.id = si.email_id
     WHERE si.has_sender = false
     ORDER BY e.received_at DESC NULLS LAST
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE OF si SKIP LOCKED
  )
  UPDATE public.email_search_index si SET
    tsv = si.tsv
      || setweight(to_tsvector('simple', COALESCE(e.from_addr, '')),                          'A')
      || setweight(to_tsvector('simple', COALESCE(private.decrypt_text(e.from_name_enc, p_key), '')), 'A')
      || setweight(to_tsvector('simple', COALESCE(private.decrypt_text(e.to_addrs_enc,  p_key), '')), 'B'),
    has_sender = true,
    updated_at = now()
  FROM picked p
  JOIN public.emails e ON e.id = p.email_id
  WHERE si.email_id = p.email_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reindex_email_search_sender(int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reindex_email_search_sender(int, text) FROM anon, authenticated;

DO $$ BEGIN PERFORM cron.unschedule('gmail-search-reindex-1m'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
SELECT cron.schedule(
  'gmail-search-reindex-1m',
  '* * * * *',
  $$ SELECT private.cron_post('/api/public/gmail-search-reindex?batch=1000&batches=5'); $$
);