ALTER TABLE public.google_sync_state
  ADD COLUMN IF NOT EXISTS sync_mode text NOT NULL DEFAULT 'pull_only'
    CHECK (sync_mode IN ('off','pull_only','two_way'));

-- Preserve current behavior for existing rows: anyone already syncing stays two-way.
UPDATE public.google_sync_state
   SET sync_mode = CASE WHEN enabled THEN 'two_way' ELSE 'off' END
 WHERE sync_mode = 'pull_only';