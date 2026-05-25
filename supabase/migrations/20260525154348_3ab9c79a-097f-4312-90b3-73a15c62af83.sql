
REVOKE EXECUTE ON FUNCTION public.bump_history_id_if_greater(uuid, text, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_forward_retries(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_message_jobs(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_dlq_jobs(integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cleanup_old_pubsub_events(integer, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cron_secret_matches(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_gmail_oauth_tokens(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_gmail_oauth_tokens(uuid, text, text, timestamptz, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_gmail_oauth_account(uuid, text, text, text, timestamptz, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.list_decryption_audit(integer) FROM PUBLIC;
