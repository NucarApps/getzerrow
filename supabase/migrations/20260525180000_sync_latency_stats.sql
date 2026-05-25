-- get_sync_latency_stats — surfaces the push→ack and push→visible
-- latency telemetry we now collect, scoped to one user's accounts.
--
--   push_to_ack: pubsub_events.latency_ms (publishTime → webhook 200)
--   push_to_visible: emails.created_at - published_at_ms
--     (publishTime → row inserted + visible in client)
--
-- Returns p50 / p95 / p99 / sample size per metric over the last 24h.
-- Empty / no-data buckets return NULL — UI should handle that.

CREATE OR REPLACE FUNCTION public.get_sync_latency_stats(
  p_user_id uuid,
  p_lookback_hours integer DEFAULT 24
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_emails       text[];
  v_account_ids  uuid[];
  v_since        timestamptz := now() - make_interval(hours => p_lookback_hours);
  v_ack_stats    jsonb;
  v_vis_stats    jsonb;
BEGIN
  -- Scope to the caller's mailboxes only.
  SELECT array_agg(email_address), array_agg(id)
    INTO v_emails, v_account_ids
    FROM public.gmail_accounts
   WHERE user_id = p_user_id;

  IF v_emails IS NULL OR array_length(v_emails, 1) = 0 THEN
    RETURN jsonb_build_object(
      'push_to_ack',     jsonb_build_object('count', 0, 'p50', NULL, 'p95', NULL, 'p99', NULL),
      'push_to_visible', jsonb_build_object('count', 0, 'p50', NULL, 'p95', NULL, 'p99', NULL),
      'since',           v_since
    );
  END IF;

  -- ── push → ack: webhook latency from pubsub_events.latency_ms ──────────
  WITH samples AS (
    SELECT latency_ms
      FROM public.pubsub_events
     WHERE event_type = 'push'
       AND email_address = ANY(v_emails)
       AND received_at >= v_since
       AND latency_ms IS NOT NULL
       AND latency_ms >= 0
       -- 1h cap: anything beyond that is an outlier (e.g., a redelivery
       -- with a publish_time from before our last outage). Filtering
       -- keeps the percentile math from being skewed by single events.
       AND latency_ms < 3600000
  )
  SELECT jsonb_build_object(
    'count', COUNT(*)::int,
    'p50',   percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms),
    'p95',   percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms),
    'p99',   percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)
  )
  INTO v_ack_stats
  FROM samples;

  -- ── push → visible: emails.created_at - published_at_ms ────────────────
  WITH samples AS (
    SELECT EXTRACT(EPOCH FROM (created_at - to_timestamp(published_at_ms / 1000.0))) * 1000 AS lat_ms
      FROM public.emails
     WHERE gmail_account_id = ANY(v_account_ids)
       AND created_at >= v_since
       AND published_at_ms IS NOT NULL
       AND published_at_ms > 0
  ),
  bounded AS (
    SELECT lat_ms FROM samples WHERE lat_ms BETWEEN 0 AND 3600000
  )
  SELECT jsonb_build_object(
    'count', COUNT(*)::int,
    'p50',   percentile_cont(0.50) WITHIN GROUP (ORDER BY lat_ms),
    'p95',   percentile_cont(0.95) WITHIN GROUP (ORDER BY lat_ms),
    'p99',   percentile_cont(0.99) WITHIN GROUP (ORDER BY lat_ms)
  )
  INTO v_vis_stats
  FROM bounded;

  RETURN jsonb_build_object(
    'push_to_ack',     v_ack_stats,
    'push_to_visible', v_vis_stats,
    'since',           v_since
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer) TO service_role;

-- The push→visible aggregation reads emails.created_at + published_at_ms
-- per-account. Without an index it's a seqscan on the emails table once
-- per dashboard load. The partial index keeps the cost proportional to
-- "emails where we actually recorded latency".
CREATE INDEX IF NOT EXISTS emails_latency_idx
  ON public.emails (gmail_account_id, created_at DESC)
  WHERE published_at_ms IS NOT NULL;
