ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS filter_tree jsonb;