
ALTER TABLE public.pubsub_events
  ADD COLUMN IF NOT EXISTS payload jsonb,
  ADD COLUMN IF NOT EXISTS message_id text,
  ADD COLUMN IF NOT EXISTS publish_time timestamptz,
  ADD COLUMN IF NOT EXISTS subscription text,
  ADD COLUMN IF NOT EXISTS details text;
