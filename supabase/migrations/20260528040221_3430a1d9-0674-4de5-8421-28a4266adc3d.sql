
CREATE OR REPLACE FUNCTION public.backfill_emails_encryption(p_batch_limit int, p_key text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT e.id, e.user_id, e.subject, e.snippet, e.body_text, e.body_html,
           e.from_name, e.to_addrs, e.cc, e.ai_summary, e.classification_reason
      FROM public.emails e
      LEFT JOIN public.email_search_index si ON si.email_id = e.id
     WHERE si.email_id IS NULL
     ORDER BY e.created_at ASC
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE OF e SKIP LOCKED
  ),
  upd AS (
    UPDATE public.emails e SET
      subject_enc               = CASE WHEN p.subject               IS NULL THEN e.subject_enc               ELSE COALESCE(e.subject_enc,               private.encrypt_text(p.subject,               p_key)) END,
      snippet_enc               = CASE WHEN p.snippet               IS NULL THEN e.snippet_enc               ELSE COALESCE(e.snippet_enc,               private.encrypt_text(p.snippet,               p_key)) END,
      body_text_enc             = CASE WHEN p.body_text             IS NULL THEN e.body_text_enc             ELSE COALESCE(e.body_text_enc,             private.encrypt_text(p.body_text,             p_key)) END,
      body_html_enc             = CASE WHEN p.body_html             IS NULL THEN e.body_html_enc             ELSE COALESCE(e.body_html_enc,             private.encrypt_text(p.body_html,             p_key)) END,
      from_name_enc             = CASE WHEN p.from_name             IS NULL THEN e.from_name_enc             ELSE COALESCE(e.from_name_enc,             private.encrypt_text(p.from_name,             p_key)) END,
      to_addrs_enc              = CASE WHEN p.to_addrs              IS NULL THEN e.to_addrs_enc              ELSE COALESCE(e.to_addrs_enc,              private.encrypt_text(p.to_addrs,              p_key)) END,
      cc_enc                    = CASE WHEN p.cc                    IS NULL THEN e.cc_enc                    ELSE COALESCE(e.cc_enc,                    private.encrypt_text(p.cc,                    p_key)) END,
      ai_summary_enc            = CASE WHEN p.ai_summary            IS NULL THEN e.ai_summary_enc            ELSE COALESCE(e.ai_summary_enc,            private.encrypt_text(p.ai_summary,            p_key)) END,
      classification_reason_enc = CASE WHEN p.classification_reason IS NULL THEN e.classification_reason_enc ELSE COALESCE(e.classification_reason_enc, private.encrypt_text(p.classification_reason, p_key)) END,
      key_version               = 1
    FROM picked p
    WHERE e.id = p.id
    RETURNING e.id, p.user_id, p.subject, p.snippet, p.body_text
  )
  INSERT INTO public.email_search_index (email_id, user_id, tsv, updated_at)
  SELECT u.id, u.user_id,
         setweight(to_tsvector('simple', COALESCE(u.subject, '')),                 'A')
      || setweight(to_tsvector('simple', COALESCE(u.snippet, '')),                 'B')
      || setweight(to_tsvector('simple', left(COALESCE(u.body_text, ''), 100000)), 'C'),
         now()
    FROM upd u
  ON CONFLICT (email_id) DO UPDATE
    SET tsv = EXCLUDED.tsv, user_id = EXCLUDED.user_id, updated_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.backfill_folder_examples_encryption(p_batch_limit int, p_key text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT id, subject, snippet FROM public.folder_examples
     WHERE (subject IS NOT NULL AND subject_enc IS NULL)
        OR (snippet IS NOT NULL AND snippet_enc IS NULL)
     ORDER BY created_at ASC
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.folder_examples f SET
    subject_enc = CASE WHEN p.subject IS NULL THEN f.subject_enc ELSE COALESCE(f.subject_enc, private.encrypt_text(p.subject, p_key)) END,
    snippet_enc = CASE WHEN p.snippet IS NULL THEN f.snippet_enc ELSE COALESCE(f.snippet_enc, private.encrypt_text(p.snippet, p_key)) END,
    key_version = 1
   FROM picked p WHERE f.id = p.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
