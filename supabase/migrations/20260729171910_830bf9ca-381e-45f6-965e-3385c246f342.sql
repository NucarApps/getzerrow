ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS mark_read_mode text NOT NULL DEFAULT 'all';

ALTER TABLE public.folders
  DROP CONSTRAINT IF EXISTS folders_mark_read_mode_check;
ALTER TABLE public.folders
  ADD CONSTRAINT folders_mark_read_mode_check CHECK (mark_read_mode IN ('all', 'except', 'only'));

CREATE TABLE IF NOT EXISTS public.folder_mark_read_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  folder_id uuid NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  match_type text NOT NULL CHECK (match_type IN ('email', 'domain')),
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (folder_id, match_type, value)
);

CREATE INDEX IF NOT EXISTS folder_mark_read_rules_folder_idx
  ON public.folder_mark_read_rules (folder_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_mark_read_rules TO authenticated;
GRANT ALL ON public.folder_mark_read_rules TO service_role;

ALTER TABLE public.folder_mark_read_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage their own mark-read rules" ON public.folder_mark_read_rules;
CREATE POLICY "Users manage their own mark-read rules"
  ON public.folder_mark_read_rules FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS folder_mark_read_rules_set_updated_at ON public.folder_mark_read_rules;
CREATE TRIGGER folder_mark_read_rules_set_updated_at
  BEFORE UPDATE ON public.folder_mark_read_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();