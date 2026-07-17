
ALTER TABLE public.google_sync_state
  ADD COLUMN IF NOT EXISTS progress_step text,
  ADD COLUMN IF NOT EXISTS progress_processed integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz;
