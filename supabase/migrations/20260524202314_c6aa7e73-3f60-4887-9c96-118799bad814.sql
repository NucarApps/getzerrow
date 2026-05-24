CREATE POLICY "Users view own sync activity"
ON public.pubsub_events
FOR SELECT
TO authenticated
USING (
  email_address IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.gmail_accounts ga
    WHERE ga.email_address = pubsub_events.email_address
      AND ga.user_id = auth.uid()
  )
);