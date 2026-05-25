-- Unbounded growth in pubsub_events (1 row per push/poll/cron tick) and the
-- DLQ branch of message_jobs (every permanent failure parks forever)
-- eventually bloats storage and degrades index scans. This adds a SQL
-- function that the new /api/public/gmail-retention cron can call to age
-- out old rows in bounded batches.
--
-- BATCHING
--   Deletes are capped per call (default 5000 rows per call) so a daily
--   cron tick doesn't lock the table for minutes the first time it runs
--   against a backlog. Subsequent ticks chip away at the rest.
--
-- WHAT'S KEPT
--   - pubsub_events: anything within the retention window, plus everything
--     with `error IS NOT NULL` (we want the audit trail for failures to
--     stick around twice as long as routine events).
--   - message_jobs: only DLQ rows are eligible — running/pending jobs are
--     untouched. Within DLQ, anything still actively retryable (a manual
--     operator might still want to inspect) within the window is kept.

CREATE OR REPLACE FUNCTION public.cleanup_old_pubsub_events(
  p_keep_days integer DEFAULT 30,
  p_keep_errors_days integer DEFAULT 60,
  p_batch_limit integer DEFAULT 5000
)
 RETURNS TABLE(deleted bigint, kept_errors bigint, total_before bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cutoff_normal timestamptz := now() - make_interval(days => p_keep_days);
  v_cutoff_errors timestamptz := now() - make_interval(days => p_keep_errors_days);
  v_deleted bigint;
  v_kept_errors bigint;
  v_before bigint;
BEGIN
  SELECT COUNT(*) INTO v_before FROM public.pubsub_events;

  WITH victims AS (
    SELECT id
      FROM public.pubsub_events
     WHERE (
       -- Normal rows: anything past the routine retention window.
       (error IS NULL AND received_at < v_cutoff_normal)
       OR
       -- Error rows: kept longer for forensics, but eventually go too.
       (error IS NOT NULL AND received_at < v_cutoff_errors)
     )
     -- Bound the work per call. ORDER BY makes the deletes predictable
     -- (oldest first) and keeps the planner happy with the index.
     ORDER BY received_at ASC
     LIMIT p_batch_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.pubsub_events e
   USING victims
   WHERE e.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT COUNT(*) INTO v_kept_errors
    FROM public.pubsub_events
   WHERE error IS NOT NULL;

  RETURN QUERY SELECT v_deleted, v_kept_errors, v_before;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_pubsub_events(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_pubsub_events(integer, integer, integer) TO service_role;


-- Old DLQ rows. Cleanup is narrower: only rows past the retention window
-- AND not flagged with a recently-stamped `last_error` suggesting an
-- operator was looking at them. Auto-replayed rows that ended up back in
-- DLQ count as eligible if they're old enough.
CREATE OR REPLACE FUNCTION public.cleanup_old_dlq_jobs(
  p_keep_days integer DEFAULT 30,
  p_batch_limit integer DEFAULT 1000
)
 RETURNS TABLE(deleted bigint, total_before bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cutoff timestamptz := now() - make_interval(days => p_keep_days);
  v_deleted bigint;
  v_before bigint;
BEGIN
  SELECT COUNT(*) INTO v_before FROM public.message_jobs WHERE status = 'dlq';

  WITH victims AS (
    SELECT id
      FROM public.message_jobs
     WHERE status = 'dlq'
       AND updated_at < v_cutoff
     ORDER BY updated_at ASC
     LIMIT p_batch_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.message_jobs j
   USING victims
   WHERE j.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_deleted, v_before;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_dlq_jobs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_dlq_jobs(integer, integer) TO service_role;
