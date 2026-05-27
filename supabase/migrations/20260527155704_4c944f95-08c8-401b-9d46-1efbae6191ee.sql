UPDATE public.emails
SET is_archived = false,
    raw_labels = (
      SELECT array_agg(DISTINCT l)
      FROM unnest(coalesce(raw_labels, ARRAY[]::text[]) || ARRAY['INBOX']) AS l
    )
WHERE gmail_message_id = '19e6a1455025344d';