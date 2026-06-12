
-- Backfill emails: encrypt + index. Processes oldest unencrypted batch.
CREATE OR REPLACE FUNCTION public.backfill_emails_encryption(p_batch_limit int, p_key text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE
  v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT id, user_id, subject, snippet, body_text, body_html,
           from_name, to_addrs, cc, ai_summary, classification_reason
      FROM public.emails
     WHERE subject_enc IS NULL
        OR (body_text IS NOT NULL AND body_text_enc IS NULL)
        OR id NOT IN (SELECT email_id FROM public.email_search_index)
     ORDER BY created_at ASC
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE SKIP LOCKED
  ),
  upd AS (
    UPDATE public.emails e SET
      subject_enc               = COALESCE(e.subject_enc,               private.encrypt_text(p.subject,               p_key)),
      snippet_enc               = COALESCE(e.snippet_enc,               private.encrypt_text(p.snippet,               p_key)),
      body_text_enc             = COALESCE(e.body_text_enc,             private.encrypt_text(p.body_text,             p_key)),
      body_html_enc             = COALESCE(e.body_html_enc,             private.encrypt_text(p.body_html,             p_key)),
      from_name_enc             = COALESCE(e.from_name_enc,             private.encrypt_text(p.from_name,             p_key)),
      to_addrs_enc              = COALESCE(e.to_addrs_enc,              private.encrypt_text(p.to_addrs,              p_key)),
      cc_enc                    = COALESCE(e.cc_enc,                    private.encrypt_text(p.cc,                    p_key)),
      ai_summary_enc            = COALESCE(e.ai_summary_enc,            private.encrypt_text(p.ai_summary,            p_key)),
      classification_reason_enc = COALESCE(e.classification_reason_enc, private.encrypt_text(p.classification_reason, p_key)),
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

CREATE OR REPLACE FUNCTION public.backfill_reply_drafts_encryption(p_batch_limit int, p_key text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT id, draft_text FROM public.reply_drafts
     WHERE draft_text_enc IS NULL
     ORDER BY created_at ASC
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.reply_drafts r
     SET draft_text_enc = private.encrypt_text(p.draft_text, p_key),
         key_version = 1
    FROM picked p WHERE r.id = p.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.backfill_contacts_encryption(p_batch_limit int, p_key text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT id, notes, relationship_summary, address_line1, address_line2, phone
      FROM public.contacts
     WHERE (notes IS NOT NULL                AND notes_enc IS NULL)
        OR (relationship_summary IS NOT NULL AND relationship_summary_enc IS NULL)
        OR (address_line1 IS NOT NULL        AND address_line1_enc IS NULL)
        OR (address_line2 IS NOT NULL        AND address_line2_enc IS NULL)
        OR (phone IS NOT NULL                AND phone_enc IS NULL)
     ORDER BY created_at ASC
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.contacts c SET
    notes_enc                = COALESCE(c.notes_enc,                private.encrypt_text(p.notes,                p_key)),
    relationship_summary_enc = COALESCE(c.relationship_summary_enc, private.encrypt_text(p.relationship_summary, p_key)),
    address_line1_enc        = COALESCE(c.address_line1_enc,        private.encrypt_text(p.address_line1,        p_key)),
    address_line2_enc        = COALESCE(c.address_line2_enc,        private.encrypt_text(p.address_line2,        p_key)),
    phone_enc                = COALESCE(c.phone_enc,                private.encrypt_text(p.phone,                p_key)),
    key_version              = 1
   FROM picked p WHERE c.id = p.id;
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
    subject_enc = COALESCE(f.subject_enc, private.encrypt_text(p.subject, p_key)),
    snippet_enc = COALESCE(f.snippet_enc, private.encrypt_text(p.snippet, p_key)),
    key_version = 1
   FROM picked p WHERE f.id = p.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_emails_encryption(int, text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_reply_drafts_encryption(int, text)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_contacts_encryption(int, text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_folder_examples_encryption(int, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_emails_encryption(int, text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_reply_drafts_encryption(int, text)    TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_contacts_encryption(int, text)        TO service_role;
GRANT EXECUTE ON FUNCTION public.backfill_folder_examples_encryption(int, text) TO service_role;
