CREATE OR REPLACE FUNCTION public.add_manual_overrides(p_ids uuid[], p_fields text[])
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE public.contacts c
     SET manual_overrides = (
       SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}')
         FROM unnest(COALESCE(c.manual_overrides, '{}') || p_fields) AS t(x)
     )
   WHERE c.id = ANY(p_ids)
     AND c.user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.add_manual_overrides(uuid[], text[]) TO authenticated;