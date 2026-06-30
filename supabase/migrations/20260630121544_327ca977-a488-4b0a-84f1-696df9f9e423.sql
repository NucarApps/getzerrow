ALTER TABLE public.email_search_index
  ADD COLUMN IF NOT EXISTS received_at timestamptz,
  ADD COLUMN IF NOT EXISTS gmail_account_id uuid;

DROP INDEX IF EXISTS public.email_search_index_tsv_idx;

CREATE OR REPLACE FUNCTION public.search_emails(p_user_id uuid, p_query text, p_limit integer, p_offset integer, p_key text, p_account_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text, from_addr text, from_name text, subject text, snippet text, received_at timestamp with time zone, is_read boolean, is_archived boolean, folder_id uuid, rank real)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
  WITH hits AS (
    SELECT si.email_id, si.received_at
    FROM public.email_search_index si
    WHERE si.user_id = p_user_id
      AND si.received_at IS NOT NULL
      AND (p_account_id IS NULL OR si.gmail_account_id = p_account_id)
      AND si.tsv @@ websearch_to_tsquery('simple', p_query)
    ORDER BY si.received_at DESC, si.email_id DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
    OFFSET GREATEST(0, COALESCE(p_offset, 0))
  )
  SELECT
    e.id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
    e.from_addr,
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.subject_enc,   p_key),
    private.decrypt_text(e.snippet_enc,   p_key),
    e.received_at, e.is_read, e.is_archived, e.folder_id,
    0::real AS rank
  FROM hits h
  JOIN public.emails e ON e.id = h.email_id
  ORDER BY h.received_at DESC, h.email_id DESC;
$function$;

CREATE OR REPLACE FUNCTION public.search_emails_participants(p_user_id uuid, p_from text, p_to text, p_rest text, p_limit integer, p_offset integer, p_key text, p_account_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text, from_addr text, from_name text, subject text, snippet text, received_at timestamp with time zone, is_read boolean, is_archived boolean, folder_id uuid, rank real)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
DECLARE
  v_from tsquery := public.build_weighted_tsquery(p_from, 'A');
  v_to   tsquery := public.build_weighted_tsquery(p_to, 'B');
  v_rest tsquery := CASE WHEN COALESCE(p_rest,'') = '' THEN NULL
                         ELSE websearch_to_tsquery('simple', p_rest) END;
BEGIN
  IF v_from IS NULL AND v_to IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT si.email_id, si.received_at
    FROM public.email_search_index si
    WHERE si.user_id = p_user_id
      AND si.received_at IS NOT NULL
      AND (p_account_id IS NULL OR si.gmail_account_id = p_account_id)
      AND (v_from IS NULL OR si.participant_tsv @@ v_from)
      AND (v_to   IS NULL OR si.participant_tsv @@ v_to)
      AND (v_rest IS NULL OR si.tsv @@ v_rest)
    ORDER BY si.received_at DESC, si.email_id DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
    OFFSET GREATEST(0, COALESCE(p_offset, 0))
  )
  SELECT
    e.id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
    e.from_addr,
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.subject_enc,   p_key),
    private.decrypt_text(e.snippet_enc,   p_key),
    e.received_at, e.is_read, e.is_archived, e.folder_id,
    0::real AS rank
  FROM hits h
  JOIN public.emails e ON e.id = h.email_id
  ORDER BY h.received_at DESC, h.email_id DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.insert_email_encrypted(p_user_id uuid, p_gmail_account_id uuid, p_gmail_message_id text, p_thread_id text, p_from_addr text, p_from_name text, p_to_addrs text, p_cc text, p_subject text, p_snippet text, p_body_text text, p_body_html text, p_received_at timestamp with time zone, p_has_attachment boolean, p_raw_labels text[], p_list_id text, p_in_reply_to text, p_published_at_ms bigint, p_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
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
       setweight(to_tsvector('simple', COALESCE(p_subject, '')),               'A')
    || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),               'B')
    || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 3000)), 'C');

  INSERT INTO public.email_search_index (email_id, user_id, gmail_account_id, tsv, received_at, updated_at)
  VALUES (v_id, p_user_id, p_gmail_account_id, v_tsv, NULL, now())
  ON CONFLICT (email_id) DO UPDATE
    SET tsv = EXCLUDED.tsv, user_id = EXCLUDED.user_id,
        gmail_account_id = EXCLUDED.gmail_account_id, updated_at = now();

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_email_encrypted(p_user_id uuid, p_gmail_account_id uuid, p_gmail_message_id text, p_thread_id text, p_from_addr text, p_from_name text, p_to_addrs text, p_cc text, p_list_id text, p_in_reply_to text, p_subject text, p_snippet text, p_body_text text, p_body_html text, p_received_at timestamp with time zone, p_is_read boolean, p_is_archived boolean, p_has_attachment boolean, p_raw_labels text[], p_classified_by text, p_processed_at timestamp with time zone, p_published_at_ms bigint, p_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
DECLARE v_id uuid; v_tsv tsvector; v_ptsv tsvector; v_cls text; v_recv timestamptz;
BEGIN
  v_cls := COALESCE(p_classified_by, 'pending');

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
    NULL, v_cls,
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

  v_recv := CASE WHEN v_cls NOT IN ('pending','pending_ai') THEN p_received_at ELSE NULL END;

  v_tsv :=
       setweight(to_tsvector('simple', COALESCE(p_from_addr, '')),             'A')
    || setweight(to_tsvector('simple', COALESCE(p_from_name, '')),             'A')
    || setweight(to_tsvector('simple', COALESCE(p_subject, '')),               'A')
    || setweight(to_tsvector('simple', COALESCE(p_to_addrs, '')),              'B')
    || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),               'B')
    || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 3000)), 'C');

  v_ptsv := public.build_participant_tsv(p_from_addr, p_from_name, p_to_addrs);

  INSERT INTO public.email_search_index (email_id, user_id, gmail_account_id, tsv, participant_tsv, received_at, has_sender, updated_at)
  VALUES (v_id, p_user_id, p_gmail_account_id, v_tsv, v_ptsv, v_recv, true, now())
  ON CONFLICT (email_id) DO UPDATE
    SET tsv = EXCLUDED.tsv, participant_tsv = EXCLUDED.participant_tsv,
        user_id = EXCLUDED.user_id, gmail_account_id = EXCLUDED.gmail_account_id,
        received_at = EXCLUDED.received_at, has_sender = true, updated_at = now();

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_email_encrypted(p_email_id uuid, p_subject text, p_snippet text, p_body_text text, p_body_html text, p_ai_summary text, p_classification_reason text, p_from_name text, p_to_addrs text, p_folder_id uuid, p_ai_confidence real, p_classified_by text, p_matched_filter_ids uuid[], p_matched_folder_ids uuid[], p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
DECLARE
  v_user_id uuid; v_acct uuid; v_cls text; v_recv timestamptz; v_idx_recv timestamptz;
  v_from_addr text; v_from_name text; v_to_addrs text;
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

  SELECT user_id, gmail_account_id, classified_by, received_at,
         from_addr,
         private.decrypt_text(from_name_enc, p_key),
         private.decrypt_text(to_addrs_enc, p_key)
    INTO v_user_id, v_acct, v_cls, v_recv, v_from_addr, v_from_name, v_to_addrs
    FROM public.emails WHERE id = p_email_id;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  v_idx_recv := CASE WHEN v_cls IS NULL OR v_cls NOT IN ('pending','pending_ai')
                     THEN v_recv ELSE NULL END;

  IF p_subject IS NOT NULL OR p_snippet IS NOT NULL OR p_body_text IS NOT NULL
     OR p_from_name IS NOT NULL OR p_to_addrs IS NOT NULL THEN
    INSERT INTO public.email_search_index (email_id, user_id, gmail_account_id, tsv, participant_tsv, received_at, has_sender, updated_at)
    VALUES (
      p_email_id, v_user_id, v_acct,
      setweight(to_tsvector('simple', COALESCE(v_from_addr, '')),                'A')
      || setweight(to_tsvector('simple', COALESCE(v_from_name, '')),            'A')
      || setweight(to_tsvector('simple', COALESCE(p_subject, '')),             'A')
      || setweight(to_tsvector('simple', COALESCE(v_to_addrs, '')),            'B')
      || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),             'B')
      || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 3000)), 'C'),
      public.build_participant_tsv(v_from_addr, v_from_name, v_to_addrs),
      v_idx_recv, true, now()
    )
    ON CONFLICT (email_id) DO UPDATE
      SET tsv = EXCLUDED.tsv, participant_tsv = EXCLUDED.participant_tsv,
          gmail_account_id = EXCLUDED.gmail_account_id,
          received_at = EXCLUDED.received_at,
          has_sender = true, updated_at = now();
  ELSE
    UPDATE public.email_search_index
       SET received_at = v_idx_recv,
           gmail_account_id = v_acct,
           updated_at = now()
     WHERE email_id = p_email_id;
  END IF;
END;
$function$;