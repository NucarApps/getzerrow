-- Whole-mailbox from:/to: participant search.
-- Adds a dedicated participant tsvector (weight A = sender, weight B = recipients)
-- so operator searches resolve server-side across the entire mailbox, by email
-- address and display name, distinguishing sender from recipient.

-- 1. Column + GIN index (btree_gin already enabled) -------------------------
ALTER TABLE public.email_search_index
  ADD COLUMN IF NOT EXISTS participant_tsv tsvector;

CREATE INDEX IF NOT EXISTS email_search_index_user_participant_idx
  ON public.email_search_index USING gin (user_id, participant_tsv);

-- 2. Helper: build the participant tsvector from sender/recipient strings ----
-- Stores BOTH the raw token (whole email lexeme) and a normalized split
-- (non-alphanumeric -> space) so partial matches like from:alice resolve
-- against alice@example.com, and names like "Alice Smith" tokenize per word.
CREATE OR REPLACE FUNCTION public.build_participant_tsv(
  p_from_addr text, p_from_name text, p_to_addrs text
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT
       setweight(to_tsvector('simple', COALESCE(p_from_addr,'') || ' ' || COALESCE(p_from_name,'')), 'A')
    || setweight(to_tsvector('simple', regexp_replace(COALESCE(p_from_addr,'') || ' ' || COALESCE(p_from_name,''), '[^a-zA-Z0-9]+', ' ', 'g')), 'A')
    || setweight(to_tsvector('simple', COALESCE(p_to_addrs,'')), 'B')
    || setweight(to_tsvector('simple', regexp_replace(COALESCE(p_to_addrs,''), '[^a-zA-Z0-9]+', ' ', 'g')), 'B');
$$;

-- 3. Helper: turn arbitrary user input into a weight-tagged AND tsquery -------
-- Lexeme-normalizes the needle (safe: lexemes carry no tsquery metacharacters)
-- then ANDs them, tagged to the given weight class. Returns NULL when empty.
CREATE OR REPLACE FUNCTION public.build_weighted_tsquery(p_text text, p_weight text)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT to_tsquery('simple', q)
  FROM (
    SELECT string_agg(lexeme || ':' || p_weight, ' & ') AS q
    FROM unnest(to_tsvector('simple', regexp_replace(COALESCE(p_text,''), '[^a-zA-Z0-9]+', ' ', 'g')))
  ) s
  WHERE q IS NOT NULL AND length(q) > 0;
$$;

-- 4. Search RPC: sender (A) / recipient (B) precision + optional free text ----
CREATE OR REPLACE FUNCTION public.search_emails_participants(
  p_user_id uuid,
  p_from text,
  p_to text,
  p_rest text,
  p_limit integer,
  p_offset integer,
  p_key text,
  p_account_id uuid DEFAULT NULL
)
RETURNS TABLE(
  id uuid, gmail_account_id uuid, gmail_message_id text, thread_id text,
  from_addr text, from_name text, subject text, snippet text,
  received_at timestamp with time zone, is_read boolean, is_archived boolean,
  folder_id uuid, rank real
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $$
DECLARE
  v_from tsquery := public.build_weighted_tsquery(p_from, 'A');
  v_to   tsquery := public.build_weighted_tsquery(p_to, 'B');
  v_rest tsquery := CASE WHEN COALESCE(p_rest,'') = '' THEN NULL
                         ELSE websearch_to_tsquery('simple', p_rest) END;
BEGIN
  -- Caller only invokes this with an operator present; bail if neither parsed.
  IF v_from IS NULL AND v_to IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    e.id, e.gmail_account_id, e.gmail_message_id, e.thread_id,
    e.from_addr,
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.subject_enc,   p_key),
    private.decrypt_text(e.snippet_enc,   p_key),
    e.received_at, e.is_read, e.is_archived, e.folder_id,
    (CASE WHEN v_rest IS NULL THEN 0 ELSE ts_rank(si.tsv, v_rest) END)::real AS rank
  FROM public.email_search_index si
  JOIN public.emails e ON e.id = si.email_id
  WHERE si.user_id = p_user_id
    AND (p_account_id IS NULL OR e.gmail_account_id = p_account_id)
    AND e.classified_by NOT IN ('pending', 'pending_ai')
    AND (v_from IS NULL OR si.participant_tsv @@ v_from)
    AND (v_to   IS NULL OR si.participant_tsv @@ v_to)
    AND (v_rest IS NULL OR si.tsv @@ v_rest)
  ORDER BY rank DESC, e.received_at DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
  OFFSET GREATEST(0, COALESCE(p_offset, 0));
END;
$$;

-- 5. Backfill: fill participant_tsv newest-first, decrypting only name/recips -
CREATE OR REPLACE FUNCTION public.reindex_email_participants(
  p_batch_limit integer, p_key text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT si.email_id
      FROM public.email_search_index si
      JOIN public.emails e ON e.id = si.email_id
     WHERE si.participant_tsv IS NULL
     ORDER BY e.received_at DESC NULLS LAST
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE OF si SKIP LOCKED
  )
  UPDATE public.email_search_index si SET
    participant_tsv = public.build_participant_tsv(
      e.from_addr,
      private.decrypt_text(e.from_name_enc, p_key),
      private.decrypt_text(e.to_addrs_enc,  p_key)
    ),
    updated_at = now()
  FROM picked p
  JOIN public.emails e ON e.id = p.email_id
  WHERE si.email_id = p.email_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 6. Populate participant_tsv on write -------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_email_encrypted(p_user_id uuid, p_gmail_account_id uuid, p_gmail_message_id text, p_thread_id text, p_from_addr text, p_from_name text, p_to_addrs text, p_cc text, p_list_id text, p_in_reply_to text, p_subject text, p_snippet text, p_body_text text, p_body_html text, p_received_at timestamp with time zone, p_is_read boolean, p_is_archived boolean, p_has_attachment boolean, p_raw_labels text[], p_classified_by text, p_processed_at timestamp with time zone, p_published_at_ms bigint, p_key text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
DECLARE v_id uuid; v_tsv tsvector; v_ptsv tsvector;
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

  v_ptsv := public.build_participant_tsv(p_from_addr, p_from_name, p_to_addrs);

  INSERT INTO public.email_search_index (email_id, user_id, tsv, participant_tsv, has_sender, updated_at)
  VALUES (v_id, p_user_id, v_tsv, v_ptsv, true, now())
  ON CONFLICT (email_id) DO UPDATE
    SET tsv = EXCLUDED.tsv, participant_tsv = EXCLUDED.participant_tsv,
        user_id = EXCLUDED.user_id, has_sender = true, updated_at = now();

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_email_encrypted(p_email_id uuid, p_subject text, p_snippet text, p_body_text text, p_body_html text, p_ai_summary text, p_classification_reason text, p_from_name text, p_to_addrs text, p_folder_id uuid, p_ai_confidence real, p_classified_by text, p_matched_filter_ids uuid[], p_matched_folder_ids uuid[], p_key text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'extensions'
AS $function$
DECLARE v_user_id uuid; v_from_addr text; v_from_name text; v_to_addrs text;
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
    SELECT user_id, from_addr,
           private.decrypt_text(from_name_enc, p_key),
           private.decrypt_text(to_addrs_enc, p_key)
      INTO v_user_id, v_from_addr, v_from_name, v_to_addrs
      FROM public.emails WHERE id = p_email_id;
    IF v_user_id IS NOT NULL THEN
      INSERT INTO public.email_search_index (email_id, user_id, tsv, participant_tsv, has_sender, updated_at)
      VALUES (
        p_email_id, v_user_id,
        setweight(to_tsvector('simple', COALESCE(v_from_addr, '')),                'A')
        || setweight(to_tsvector('simple', COALESCE(v_from_name, '')),            'A')
        || setweight(to_tsvector('simple', COALESCE(p_subject, '')),             'A')
        || setweight(to_tsvector('simple', COALESCE(v_to_addrs, '')),            'B')
        || setweight(to_tsvector('simple', COALESCE(p_snippet, '')),             'B')
        || setweight(to_tsvector('simple', left(COALESCE(p_body_text, ''), 100000)), 'C'),
        public.build_participant_tsv(v_from_addr, v_from_name, v_to_addrs),
        true, now()
      )
      ON CONFLICT (email_id) DO UPDATE
        SET tsv = EXCLUDED.tsv, participant_tsv = EXCLUDED.participant_tsv,
            has_sender = true, updated_at = now();
    END IF;
  END IF;
END;
$function$;