CREATE OR REPLACE FUNCTION public.get_folder_unread_counts(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  WITH scoped AS (
    SELECT
      e.folder_id,
      e.is_read,
      e.raw_labels,
      e.classified_by,
      e.snoozed_until,
      COALESCE(f.auto_archive, false) AS folder_auto_archive,
      COALESCE(f.hide_from_inbox, false) AS folder_hide_from_inbox
      FROM public.emails e
      LEFT JOIN public.folders f
        ON f.id = e.folder_id
       AND f.user_id = e.user_id
       AND f.gmail_account_id = e.gmail_account_id
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
       AND (snoozed_until IS NULL OR snoozed_until <= now())
       AND (classified_by IS NULL OR classified_by NOT IN ('pending', 'pending_ai'))
       AND NOT EXISTS (
         SELECT 1 FROM unnest(COALESCE(raw_labels, '{}')) l WHERE l LIKE 'Label\_%'
       )
  ),
  total AS (
    SELECT COUNT(*) AS n
      FROM scoped
     WHERE is_read = false
       AND (snoozed_until IS NULL OR snoozed_until <= now())
       AND (classified_by IS NULL OR classified_by NOT IN ('pending', 'pending_ai'))
       AND raw_labels @> ARRAY['INBOX']
       AND folder_auto_archive = false
       AND folder_hide_from_inbox = false
  )
  SELECT jsonb_build_object(
    'byFolder', COALESCE((SELECT jsonb_object_agg(folder_id::text, n) FROM per_folder), '{}'::jsonb),
    'no_rules', COALESCE((SELECT n FROM no_rules), 0),
    'total',    COALESCE((SELECT n FROM total), 0)
  );
$function$;

REVOKE EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_folder_unread_counts(uuid) TO authenticated, service_role;