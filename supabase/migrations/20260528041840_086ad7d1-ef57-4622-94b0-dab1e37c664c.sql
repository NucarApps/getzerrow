CREATE OR REPLACE FUNCTION public.backfill_folder_examples_encryption(p_batch_limit integer, p_key text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions'
AS $function$
DECLARE v_count int := 0;
BEGIN
  WITH picked AS (
    SELECT id, subject, snippet FROM public.folder_examples
     WHERE (subject IS NOT NULL AND length(subject) > 0 AND subject_enc IS NULL)
        OR (snippet IS NOT NULL AND length(snippet) > 0 AND snippet_enc IS NULL)
     ORDER BY created_at ASC
     LIMIT GREATEST(1, LEAST(p_batch_limit, 5000))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.folder_examples f SET
    subject_enc = CASE WHEN p.subject IS NULL OR length(p.subject) = 0 THEN f.subject_enc ELSE COALESCE(f.subject_enc, private.encrypt_text(p.subject, p_key)) END,
    snippet_enc = CASE WHEN p.snippet IS NULL OR length(p.snippet) = 0 THEN f.snippet_enc ELSE COALESCE(f.snippet_enc, private.encrypt_text(p.snippet, p_key)) END,
    key_version = 1
   FROM picked p WHERE f.id = p.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;