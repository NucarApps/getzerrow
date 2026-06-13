-- 1. Server-side unread/folder counts (called from the browser; relies on auth.uid()).
CREATE OR REPLACE FUNCTION public.get_folder_unread_counts(p_account_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH scoped AS (
    SELECT e.folder_id, e.is_read, e.raw_labels
      FROM public.emails e
     WHERE e.gmail_account_id = p_account_id
       AND e.user_id = auth.uid()
  ),
  per_folder AS (
    SELECT folder_id, COUNT(*) AS n
      FROM scoped
     WHERE folder_id IS NOT NULL AND is_read = false
     GROUP BY folder_id
  ),
  no_rules AS (
    SELECT COUNT(*) AS n
      FROM scoped
     WHERE folder_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM unnest(COALESCE(raw_labels, '{}')) l WHERE l LIKE 'Label\_%'
       )
  ),
  total AS (
    SELECT COUNT(*) AS n
      FROM scoped
     WHERE is_read = false AND raw_labels @> ARRAY['INBOX']
  )
  SELECT jsonb_build_object(
    'byFolder', COALESCE((SELECT jsonb_object_agg(folder_id::text, n) FROM per_folder), '{}'::jsonb),
    'no_rules', COALESCE((SELECT n FROM no_rules), 0),
    'total',    COALESCE((SELECT n FROM total), 0)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) TO service_role;

-- 2. Single-round-trip decrypted, paginated inbox list.
--    Called server-side (service role) with p_key + p_user_id from the auth context.
CREATE OR REPLACE FUNCTION public.get_emails_list_decrypted(
  p_account_id uuid,
  p_user_id    uuid,
  p_scope      text,
  p_folder_id  uuid,
  p_cursor     timestamptz,
  p_limit      integer,
  p_key        text
)
RETURNS TABLE(
  id uuid,
  from_addr text,
  from_name text,
  subject text,
  snippet text,
  to_addrs text,
  ai_summary text,
  classification_reason text,
  received_at timestamptz,
  is_read boolean,
  is_archived boolean,
  folder_id uuid,
  ai_confidence real,
  thread_id text,
  classified_by text,
  matched_filter_ids uuid[],
  matched_folder_ids uuid[],
  has_attachment boolean,
  processed_at timestamptz,
  raw_labels text[],
  snoozed_until timestamptz,
  gmail_message_id text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, private, extensions
AS $$
  SELECT
    e.id,
    e.from_addr,
    private.decrypt_text(e.from_name_enc, p_key),
    private.decrypt_text(e.subject_enc, p_key),
    private.decrypt_text(e.snippet_enc, p_key),
    private.decrypt_text(e.to_addrs_enc, p_key),
    private.decrypt_text(e.ai_summary_enc, p_key),
    private.decrypt_text(e.classification_reason_enc, p_key),
    e.received_at, e.is_read, e.is_archived, e.folder_id, e.ai_confidence,
    e.thread_id, e.classified_by, e.matched_filter_ids, e.matched_folder_ids,
    e.has_attachment, e.processed_at, e.raw_labels, e.snoozed_until, e.gmail_message_id
  FROM public.emails e
  WHERE e.gmail_account_id = p_account_id
    AND e.user_id = p_user_id
    AND (p_cursor IS NULL OR e.received_at < p_cursor)
    AND (
      p_scope = 'all_mail'
      OR (
        (e.snoozed_until IS NULL OR e.snoozed_until <= now())
        AND (
          (p_scope = 'all' AND e.raw_labels @> ARRAY['INBOX'] AND e.is_archived = false)
          OR (p_scope = 'no_rules' AND e.folder_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM unnest(COALESCE(e.raw_labels, '{}')) l WHERE l LIKE 'Label\_%'
              ))
          OR (p_scope = 'folder' AND e.folder_id = p_folder_id)
        )
      )
    )
  ORDER BY e.received_at DESC NULLS LAST
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500));
$$;

GRANT EXECUTE ON FUNCTION public.get_emails_list_decrypted(uuid, uuid, text, uuid, timestamptz, integer, text) TO service_role;

-- 3. Partial index matching the dominant active-inbox list query shape.
CREATE INDEX IF NOT EXISTS emails_inbox_active_idx
  ON public.emails (gmail_account_id, received_at DESC)
  WHERE is_archived = false;