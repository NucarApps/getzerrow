ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS surface_ai_rule text,
  ADD COLUMN IF NOT EXISTS surface_names text;