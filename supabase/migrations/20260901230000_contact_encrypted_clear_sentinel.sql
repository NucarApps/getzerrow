-- set_contact_encrypted_fields treats a NULL argument as "leave this column
-- alone", which is what every partial writer (enrichment, CardDAV merge,
-- Google pull) needs. It left no way to CLEAR a field: a user who emptied
-- their contact's phone or notes sent NULL, the column was kept, and the old
-- value reappeared on the next read.
--
-- p_clear names the columns to blank out explicitly. NULL still means "keep",
-- a non-NULL value still means "set"; a name listed in p_clear wins over both
-- and stores NULL.
DROP FUNCTION IF EXISTS public.set_contact_encrypted_fields(uuid, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION public.set_contact_encrypted_fields(
  p_contact_id uuid,
  p_notes text,
  p_relationship_summary text,
  p_address_line1 text,
  p_address_line2 text,
  p_phone text,
  p_key text,
  p_clear text[] DEFAULT '{}'::text[]
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
DECLARE
  v_clear text[] := COALESCE(p_clear, '{}'::text[]);
BEGIN
  UPDATE public.contacts SET
    notes_enc = CASE
      WHEN 'notes' = ANY(v_clear) THEN NULL
      WHEN p_notes IS NULL THEN notes_enc
      ELSE private.encrypt_text(p_notes, p_key) END,
    relationship_summary_enc = CASE
      WHEN 'relationship_summary' = ANY(v_clear) THEN NULL
      WHEN p_relationship_summary IS NULL THEN relationship_summary_enc
      ELSE private.encrypt_text(p_relationship_summary, p_key) END,
    address_line1_enc = CASE
      WHEN 'address_line1' = ANY(v_clear) THEN NULL
      WHEN p_address_line1 IS NULL THEN address_line1_enc
      ELSE private.encrypt_text(p_address_line1, p_key) END,
    address_line2_enc = CASE
      WHEN 'address_line2' = ANY(v_clear) THEN NULL
      WHEN p_address_line2 IS NULL THEN address_line2_enc
      ELSE private.encrypt_text(p_address_line2, p_key) END,
    phone_enc = CASE
      WHEN 'phone' = ANY(v_clear) THEN NULL
      WHEN p_phone IS NULL THEN phone_enc
      ELSE private.encrypt_text(p_phone, p_key) END,
    summary_generated_at = CASE
      WHEN 'relationship_summary' = ANY(v_clear) THEN NULL
      WHEN p_relationship_summary IS NULL THEN summary_generated_at
      ELSE now() END,
    updated_at = now()
  WHERE id = p_contact_id;
END;
$$;
