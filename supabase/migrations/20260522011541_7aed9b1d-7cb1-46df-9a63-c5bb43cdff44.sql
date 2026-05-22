ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS filter_logic text NOT NULL DEFAULT 'any'
    CHECK (filter_logic IN ('any','all'));

ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS matched_folder_ids uuid[] NOT NULL DEFAULT '{}';