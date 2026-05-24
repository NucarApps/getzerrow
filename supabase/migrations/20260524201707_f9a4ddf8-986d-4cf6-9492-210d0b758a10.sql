CREATE OR REPLACE FUNCTION public.cron_secret_matches(provided text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = private, public
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM private.cron_settings
    WHERE name = 'cron_secret'
      AND value IS NOT NULL
      AND length(value) > 0
      AND value = provided
  ), false);
$$;

REVOKE ALL ON FUNCTION public.cron_secret_matches(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cron_secret_matches(text) FROM anon;
REVOKE ALL ON FUNCTION public.cron_secret_matches(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cron_secret_matches(text) TO service_role;