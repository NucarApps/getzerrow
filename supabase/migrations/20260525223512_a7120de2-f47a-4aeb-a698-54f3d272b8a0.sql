
CREATE OR REPLACE FUNCTION public.admin_user_stats()
RETURNS TABLE(
  user_id uuid,
  email_count bigint,
  folder_count bigint,
  contact_count bigint,
  jobs_pending bigint,
  jobs_running bigint,
  jobs_dlq bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH e AS (
    SELECT user_id, COUNT(*) AS n FROM public.emails GROUP BY user_id
  ),
  f AS (
    SELECT user_id, COUNT(*) AS n FROM public.folders GROUP BY user_id
  ),
  c AS (
    SELECT user_id, COUNT(*) AS n FROM public.contacts GROUP BY user_id
  ),
  jp AS (
    SELECT user_id, COUNT(*) AS n FROM public.message_jobs WHERE status = 'pending' GROUP BY user_id
  ),
  jr AS (
    SELECT user_id, COUNT(*) AS n FROM public.message_jobs WHERE status = 'running' GROUP BY user_id
  ),
  jd AS (
    SELECT user_id, COUNT(*) AS n FROM public.message_jobs WHERE status = 'dlq' GROUP BY user_id
  ),
  ids AS (
    SELECT user_id FROM e
    UNION SELECT user_id FROM f
    UNION SELECT user_id FROM c
    UNION SELECT user_id FROM jp
    UNION SELECT user_id FROM jr
    UNION SELECT user_id FROM jd
  )
  SELECT
    i.user_id,
    COALESCE(e.n, 0),
    COALESCE(f.n, 0),
    COALESCE(c.n, 0),
    COALESCE(jp.n, 0),
    COALESCE(jr.n, 0),
    COALESCE(jd.n, 0)
  FROM ids i
  LEFT JOIN e ON e.user_id = i.user_id
  LEFT JOIN f ON f.user_id = i.user_id
  LEFT JOIN c ON c.user_id = i.user_id
  LEFT JOIN jp ON jp.user_id = i.user_id
  LEFT JOIN jr ON jr.user_id = i.user_id
  LEFT JOIN jd ON jd.user_id = i.user_id;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_user_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_stats() TO service_role;

CREATE OR REPLACE FUNCTION public.admin_daily_activity(p_days integer DEFAULT 30)
RETURNS TABLE(day date, signups integer, emails integer)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH days AS (
    SELECT generate_series(
      (current_date - (GREATEST(1, LEAST(p_days, 365)) - 1) * interval '1 day')::date,
      current_date,
      interval '1 day'
    )::date AS day
  ),
  s AS (
    SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
      FROM auth.users
     WHERE created_at >= current_date - (GREATEST(1, LEAST(p_days, 365)) - 1) * interval '1 day'
     GROUP BY 1
  ),
  e AS (
    SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
      FROM public.emails
     WHERE created_at >= current_date - (GREATEST(1, LEAST(p_days, 365)) - 1) * interval '1 day'
     GROUP BY 1
  )
  SELECT d.day, COALESCE(s.n, 0), COALESCE(e.n, 0)
    FROM days d
    LEFT JOIN s ON s.day = d.day
    LEFT JOIN e ON e.day = d.day
   ORDER BY d.day;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_daily_activity(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_daily_activity(integer) TO service_role;
