REVOKE EXECUTE ON FUNCTION public.verify_carddav_token(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_carddav_token(text, text) TO service_role;