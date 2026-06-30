-- Make the no-client-access posture of pubsub_events explicit.
-- This table is an internal Gmail Pub/Sub webhook event log (contains
-- email_address + payload). It is only written/read by server-side code
-- using the service role, which bypasses RLS. No end user should ever read it.

-- Ensure the webhook/admin server code (service_role) retains full access.
GRANT ALL ON public.pubsub_events TO service_role;

-- Explicitly deny all access to client roles (Data API). RLS is already
-- enabled with no permissive policies, but an explicit restrictive policy
-- documents intent and guarantees no broad SELECT can ever apply.
DROP POLICY IF EXISTS "No client access to pubsub_events" ON public.pubsub_events;
CREATE POLICY "No client access to pubsub_events"
  ON public.pubsub_events
  FOR ALL
  TO authenticated, anon
  USING (false)
  WITH CHECK (false);