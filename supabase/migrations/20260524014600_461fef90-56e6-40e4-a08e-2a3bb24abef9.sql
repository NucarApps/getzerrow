ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS auto_relearn boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS relearn_threshold integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS emails_since_learn integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_folders_auto_relearn_due
  ON public.folders (last_learned_at NULLS FIRST)
  WHERE auto_relearn = true;