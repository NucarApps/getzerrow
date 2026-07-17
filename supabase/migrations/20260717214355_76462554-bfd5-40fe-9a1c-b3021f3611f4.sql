REVOKE ALL ON FUNCTION public.prune_carddav_tombstones(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_carddav_tombstones(integer) TO service_role;