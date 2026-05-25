-- claim_message_jobs needs to return published_at_ms so workers can
-- populate emails.published_at_ms (end-to-end push latency telemetry).
-- Without this the column added by 20260525150000 stays null on every
-- worker-drained job.
CREATE OR REPLACE FUNCTION public.claim_message_jobs(p_limit integer, p_priority integer DEFAULT NULL::integer)
 RETURNS TABLE(
   id uuid,
   gmail_account_id uuid,
   gmail_message_id text,
   user_id uuid,
   attempt integer,
   priority smallint,
   published_at_ms bigint
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id
    FROM public.message_jobs j
    WHERE j.status <> 'dlq'
      AND j.next_run_at <= now()
      AND (j.locked_at IS NULL OR j.locked_at < now() - interval '60 seconds')
      AND (p_priority IS NULL OR j.priority = p_priority)
    ORDER BY j.priority ASC, j.next_run_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.message_jobs j
     SET status = 'running',
         locked_at = now(),
         updated_at = now()
    FROM picked
   WHERE j.id = picked.id
   RETURNING j.id, j.gmail_account_id, j.gmail_message_id, j.user_id, j.attempt, j.priority, j.published_at_ms;
END;
$function$;
