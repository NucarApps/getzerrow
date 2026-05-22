ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS auto_star boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hide_from_inbox boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_ai boolean NOT NULL DEFAULT false;