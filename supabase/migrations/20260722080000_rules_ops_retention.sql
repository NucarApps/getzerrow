-- Retention for the rules-engine operational tables (rules upgrade, task 13).
--
-- scheduled_actions grows by one row per queued action execution and
-- digest_items by one row per digested email; neither had an age-out
-- path, so both would grow monotonically forever (the same failure mode
-- pubsub_events / message_jobs DLQ had before 20260525200000).
--
-- WHAT'S KEPT
--   - scheduled_actions: pending/running rows are the live queue — never
--     touched. done/cancelled rows age out after the routine window.
--     error rows are the queue's DLQ (parked after max attempts) and are
--     kept longer for operator forensics, mirroring pubsub_events'
--     error-row policy.
--   - digest_items: rows with sent_at IS NULL are the hourly sender's
--     work queue — never touched. Sent rows are history and age out.
--
-- Deletes are batched (bounded per call, oldest first, SKIP LOCKED) like
-- cleanup_old_pubsub_events so the daily retention tick never locks a
-- backlogged table; subsequent ticks chip away at any backlog.

CREATE OR REPLACE FUNCTION public.cleanup_old_scheduled_actions(
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
  SELECT COUNT(*) INTO v_before FROM public.scheduled_actions;

  WITH victims AS (
    SELECT id
      FROM public.scheduled_actions
     WHERE (
       (status IN ('done', 'cancelled') AND created_at < v_cutoff_normal)
       OR
       (status = 'error' AND created_at < v_cutoff_errors)
     )
     ORDER BY created_at ASC
     LIMIT p_batch_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.scheduled_actions s
   USING victims
   WHERE s.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  SELECT COUNT(*) INTO v_kept_errors
    FROM public.scheduled_actions
   WHERE status = 'error';

  RETURN QUERY SELECT v_deleted, v_kept_errors, v_before;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_scheduled_actions(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_scheduled_actions(integer, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.cleanup_old_digest_items(
  p_keep_days integer DEFAULT 30,
  p_batch_limit integer DEFAULT 5000
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
  SELECT COUNT(*) INTO v_before FROM public.digest_items;

  WITH victims AS (
    SELECT id
      FROM public.digest_items
     WHERE sent_at IS NOT NULL
       AND sent_at < v_cutoff
     ORDER BY sent_at ASC
     LIMIT p_batch_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.digest_items d
   USING victims
   WHERE d.id = victims.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN QUERY SELECT v_deleted, v_before;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.cleanup_old_digest_items(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_old_digest_items(integer, integer) TO service_role;
