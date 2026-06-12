-- 1. Lock down internal SECURITY DEFINER helper functions so they can only be
--    called by the trusted backend service role (they are invoked exclusively
--    via supabaseAdmin server-side). They accept the encryption key / privileged
--    inputs and must never be reachable through the anon or authenticated API.

REVOKE EXECUTE ON FUNCTION public.claim_forward_retries_v2(integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_forward_retries_v2(integer, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_contacts_list_fields_decrypted(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_contacts_list_fields_decrypted(uuid[], text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_emails_list_fields_decrypted(uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_emails_list_fields_decrypted(uuid[], text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_sync_latency_stats(uuid, integer) TO service_role;

-- 2. Explicitly block anonymous visitors from inserting card analytics events.
--    These rows are only ever written server-side via the service role, so an
--    explicit deny for the anon role hardens against any client-side write.
DROP POLICY IF EXISTS "Block anon card_events inserts" ON public.card_events;
CREATE POLICY "Block anon card_events inserts"
  ON public.card_events
  FOR INSERT
  TO anon
  WITH CHECK (false);