CREATE TABLE public.card_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  card_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  handle text NOT NULL,
  event_type text NOT NULL,
  link_kind text,
  link_url text,
  referrer text,
  user_agent text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX idx_card_events_owner_created ON public.card_events (owner_user_id, created_at DESC);
CREATE INDEX idx_card_events_card_created ON public.card_events (card_id, created_at DESC);
CREATE INDEX idx_card_events_handle ON public.card_events (handle);

ALTER TABLE public.card_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners view own card events"
ON public.card_events
FOR SELECT
TO authenticated
USING (auth.uid() = owner_user_id);
-- Inserts are performed server-side via supabaseAdmin (no RLS insert policy needed).
