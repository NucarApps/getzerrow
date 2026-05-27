
ALTER TABLE public.inbox_overrides ADD COLUMN IF NOT EXISTS gmail_account_id uuid;

UPDATE public.inbox_overrides io
SET gmail_account_id = sub.id
FROM (
  SELECT DISTINCT ON (user_id) user_id, id
  FROM public.gmail_accounts
  ORDER BY user_id, created_at ASC
) sub
WHERE io.user_id = sub.user_id AND io.gmail_account_id IS NULL;

CREATE INDEX IF NOT EXISTS inbox_overrides_user_account_idx
  ON public.inbox_overrides (user_id, gmail_account_id);

CREATE OR REPLACE FUNCTION public.get_sync_latency_stats(
  p_user_id uuid,
  p_lookback_hours integer DEFAULT 24,
  p_account_id uuid DEFAULT NULL
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
  IF p_account_id IS NOT NULL THEN
    SELECT array_agg(email_address), array_agg(id)
      INTO v_emails, v_account_ids
      FROM public.gmail_accounts
     WHERE user_id = p_user_id AND id = p_account_id;
  ELSE
    SELECT array_agg(email_address), array_agg(id)
      INTO v_emails, v_account_ids
      FROM public.gmail_accounts
     WHERE user_id = p_user_id;
  END IF;

  IF v_emails IS NULL OR array_length(v_emails, 1) = 0 THEN
    RETURN jsonb_build_object(
      'push_to_ack',     jsonb_build_object('count', 0, 'p50', NULL, 'p95', NULL, 'p99', NULL),
      'push_to_visible', jsonb_build_object('count', 0, 'p50', NULL, 'p95', NULL, 'p99', NULL),
      'since',           v_since
    );
  END IF;

  WITH samples AS (
    SELECT latency_ms
      FROM public.pubsub_events
     WHERE event_type = 'push'
       AND email_address = ANY(v_emails)
       AND received_at >= v_since
       AND latency_ms IS NOT NULL
       AND latency_ms >= 0
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
