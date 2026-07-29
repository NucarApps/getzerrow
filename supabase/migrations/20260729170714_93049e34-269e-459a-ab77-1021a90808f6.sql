ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS reply_to_addr text,
  ADD COLUMN IF NOT EXISTS origin_addr text,
  ADD COLUMN IF NOT EXISTS is_forwarded boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS emails_origin_addr_idx
  ON public.emails (gmail_account_id, origin_addr)
  WHERE origin_addr IS NOT NULL;

DROP FUNCTION IF EXISTS public.upsert_email_encrypted(uuid, uuid, text, text, text, text, text, text, text, text, text, text, text, text, timestamptz, boolean, boolean, boolean, text[], text, timestamptz, bigint, text);

CREATE OR REPLACE FUNCTION public.upsert_email_encrypted(
  p_user_id uuid, p_gmail_account_id uuid, p_gmail_message_id text, p_thread_id text,
  p_from_addr text, p_from_name text, p_to_addrs text, p_cc text, p_list_id text,
  p_in_reply_to text, p_subject text, p_snippet text, p_body_text text, p_body_html text,
  p_received_at timestamp with time zone, p_is_read boolean, p_is_archived boolean,
  p_has_attachment boolean, p_raw_labels text[], p_classified_by text,
  p_processed_at timestamp with time zone, p_published_at_ms bigint, p_key text,
  p_reply_to_addr text DEFAULT NULL, p_origin_addr text DEFAULT NULL,
  p_is_forwarded boolean DEFAULT false
)
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
    folder_id, classified_by, processed_at, published_at_ms, key_version,
    reply_to_addr, origin_addr, is_forwarded
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
    p_processed_at, p_published_at_ms, 1,
    p_reply_to_addr, p_origin_addr, COALESCE(p_is_forwarded, false)
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
    key_version     = 1,
    reply_to_addr   = EXCLUDED.reply_to_addr,
    origin_addr     = EXCLUDED.origin_addr,
    is_forwarded    = EXCLUDED.is_forwarded
  RETURNING id INTO v_id;

  v_recv := CASE WHEN v_cls NOT IN ('pending','pending_ai') THEN p_received_at ELSE NULL END;

  v_tsv :=
       setweight(to_tsvector('simple', COALESCE(p_from_addr, '')),             'A')
    || setweight(to_tsvector('simple', COALESCE(p_from_name, '')),             'A')
    || setweight(to_tsvector('simple', COALESCE(p_origin_addr, '')),           'A')
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