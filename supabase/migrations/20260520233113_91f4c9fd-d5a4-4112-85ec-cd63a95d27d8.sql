UPDATE public.emails
SET is_archived = true
WHERE classified_by = 'manual_strip'
  AND NOT (COALESCE(raw_labels, '{}') @> ARRAY['INBOX']);