
CREATE TABLE public.pubsub_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  event_type text NOT NULL DEFAULT 'push',
  email_address text,
  history_id text,
  accounts_matched integer,
  synced_count integer,
  error text
);
CREATE INDEX pubsub_events_received_at_idx ON public.pubsub_events (received_at DESC);
ALTER TABLE public.pubsub_events ENABLE ROW LEVEL SECURITY;
-- No policies = no access for authenticated/anon roles; service role bypasses RLS.

ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS processed_at timestamp with time zone;
