ALTER TABLE public.google_sync_state
  ADD COLUMN IF NOT EXISTS last_pull_created integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_pull_updated integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_pull_skipped_no_email integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_pull_merged integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_pull_failed integer NOT NULL DEFAULT 0;