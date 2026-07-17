ALTER TABLE public.google_sync_state
  ADD COLUMN IF NOT EXISTS sync_interval_minutes integer NOT NULL DEFAULT 15;

ALTER TABLE public.google_sync_state
  DROP CONSTRAINT IF EXISTS google_sync_state_interval_check;

ALTER TABLE public.google_sync_state
  ADD CONSTRAINT google_sync_state_interval_check
  CHECK (sync_interval_minutes IN (5, 15, 60));