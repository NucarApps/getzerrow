
REVOKE EXECUTE ON FUNCTION public.claim_message_jobs(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_message_jobs(int, int) TO service_role;
