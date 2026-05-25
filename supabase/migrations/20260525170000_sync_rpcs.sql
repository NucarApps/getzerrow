-- Two RPCs that move overlapping-writer safety into the database instead of
-- relying on the per-process JS lock + EvalPlanQual semantics.
--
-- 1. bump_history_id_if_greater — atomic monotonic guard for gmail_accounts.
--    history_id. Gmail history IDs are unsigned 64-bit (stored as text in
--    the column). Two replicas handling overlapping Pub/Sub pushes can
--    otherwise race on UPDATE and store the LOWER id last, causing the next
--    sync to re-fetch a history window we've already processed. This casts
--    to numeric (handles any-length decimal) and writes only when strictly
--    greater than the current value.
--
-- 2. claim_forward_retries — atomic "stamp + filter" claim for emails that
--    need a forward retry. Mirrors claim_message_jobs' FOR UPDATE SKIP
--    LOCKED pattern so two cron ticks can't double-send a forward.

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
  -- p_new_history_id must be a non-empty decimal string. NULL or non-numeric
  -- input is a no-op (returns false).
  IF p_new_history_id IS NULL OR p_new_history_id !~ '^\d+$' THEN
    RETURN false;
  END IF;

  -- Atomic conditional UPDATE: only write when the incoming id is strictly
  -- higher than what's stored. NULL current id always loses to a real id.
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

  -- If we didn't bump history (a peer raced ahead), still stamp the
  -- watch_expiration if the caller provided one — losing that would leave
  -- the watch looking expired in our records when it isn't.
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


-- ─── claim_forward_retries ───────────────────────────────────────────────
-- Picks N emails due for a forward retry and atomically stamps
-- forward_locked_at = now() on them. Skips rows another tx already locked
-- within the last 60s. Returns the rows so the caller can sendMessage()
-- without re-querying.
CREATE OR REPLACE FUNCTION public.claim_forward_retries(
  p_limit integer
)
 RETURNS TABLE(
   id uuid,
   gmail_account_id uuid,
   gmail_message_id text,
   folder_id uuid,
   subject text,
   from_addr text,
   from_name text,
   body_text text,
   snippet text,
   received_at timestamptz,
   forward_attempts smallint
 )
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
   RETURNING
     e.id,
     e.gmail_account_id,
     e.gmail_message_id,
     e.folder_id,
     e.subject,
     e.from_addr,
     e.from_name,
     e.body_text,
     e.snippet,
     e.received_at,
     e.forward_attempts;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_forward_retries(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_forward_retries(integer) TO service_role;
