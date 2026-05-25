CREATE OR REPLACE FUNCTION public.bump_history_id_if_greater(
  p_account_id uuid,
  p_new_history_id text,
  p_watch_expiration timestamptz DEFAULT NULL
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF p_new_history_id IS NULL OR p_new_history_id !~ '^\d+$' THEN
    RETURN false;
  END IF;
  UPDATE public.gmail_accounts
     SET history_id = p_new_history_id,
         last_poll_at = now(),
         watch_expiration = COALESCE(p_watch_expiration, watch_expiration),
         updated_at = now()
   WHERE id = p_account_id
     AND (
       history_id IS NULL
       OR (history_id ~ '^\d+$' AND history_id::numeric < p_new_history_id::numeric)
     );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 AND p_watch_expiration IS NOT NULL THEN
    UPDATE public.gmail_accounts
       SET watch_expiration = p_watch_expiration,
           last_poll_at = now(),
           updated_at = now()
     WHERE id = p_account_id;
  END IF;
  RETURN v_updated > 0;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.bump_history_id_if_greater(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_history_id_if_greater(uuid, text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_forward_retries(p_limit integer)
 RETURNS TABLE(id uuid, gmail_account_id uuid, gmail_message_id text, folder_id uuid, subject text, from_addr text, from_name text, body_text text, snippet text, received_at timestamptz, forward_attempts smallint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT e.id
      FROM public.emails e
     WHERE e.forward_next_retry_at IS NOT NULL
       AND e.forward_next_retry_at <= now()
       AND e.forward_attempts < 5
       AND e.forwarded_at IS NULL
       AND (e.forward_locked_at IS NULL OR e.forward_locked_at < now() - interval '60 seconds')
     ORDER BY e.forward_next_retry_at ASC
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.emails e
     SET forward_locked_at = now()
    FROM picked
   WHERE e.id = picked.id
   RETURNING e.id, e.gmail_account_id, e.gmail_message_id, e.folder_id, e.subject, e.from_addr, e.from_name, e.body_text, e.snippet, e.received_at, e.forward_attempts;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_forward_retries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_forward_retries(integer) TO service_role;