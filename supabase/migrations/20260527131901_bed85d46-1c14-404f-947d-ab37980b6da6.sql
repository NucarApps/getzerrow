
REVOKE EXECUTE ON FUNCTION public.claim_folder_summary_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_folder_summary_jobs(integer) TO service_role;
