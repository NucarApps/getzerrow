
-- 1. Block inserts into message_jobs from authenticated users (server uses service role).
CREATE POLICY "Block client message_jobs inserts"
ON public.message_jobs
FOR INSERT
TO authenticated
WITH CHECK (false);

-- 2. Revoke EXECUTE on SECURITY DEFINER helpers from anon and authenticated roles.
REVOKE EXECUTE ON FUNCTION public.bump_history_id_if_greater(uuid, text, timestamptz) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_forward_retries(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_message_jobs(integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_dlq_jobs(integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_pubsub_events(integer, integer, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cron_secret_matches(text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_decryption_audit(integer) FROM anon, authenticated;
