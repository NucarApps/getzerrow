
CREATE TABLE public.contact_group_suggestions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  name text NOT NULL,
  parent_group_id uuid REFERENCES public.contact_groups(id) ON DELETE SET NULL,
  existing_group_id uuid REFERENCES public.contact_groups(id) ON DELETE SET NULL,
  contact_ids uuid[] NOT NULL DEFAULT '{}',
  rationale text,
  kind text NOT NULL DEFAULT 'new',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_group_suggestions TO authenticated;
GRANT ALL ON public.contact_group_suggestions TO service_role;

ALTER TABLE public.contact_group_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own contact group suggestions"
  ON public.contact_group_suggestions FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX contact_group_suggestions_user_run_idx
  ON public.contact_group_suggestions (user_id, run_id, created_at DESC);

CREATE TRIGGER contact_group_suggestions_updated
  BEFORE UPDATE ON public.contact_group_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
