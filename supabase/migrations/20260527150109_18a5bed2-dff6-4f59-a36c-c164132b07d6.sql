UPDATE public.emails
SET is_archived = false,
    raw_labels = (
      SELECT array_agg(DISTINCT l)
      FROM unnest(coalesce(raw_labels, ARRAY[]::text[]) || ARRAY['INBOX']) AS l
    ),
    classification_reason = coalesce(classification_reason, '') || ' (restored to inbox)'
WHERE classified_by = 'inbox_override'
  AND is_archived = true
  AND NOT ('INBOX' = ANY(coalesce(raw_labels, ARRAY[]::text[])));