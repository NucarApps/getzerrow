DROP POLICY IF EXISTS "Users view own sync activity" ON public.pubsub_events;

REVOKE SELECT ON public.pubsub_events FROM authenticated;