ALTER TABLE public.emails
  ADD COLUMN IF NOT EXISTS placed_by_user boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS decision_confirmed_at timestamptz;

ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.folder_filters
  ADD COLUMN IF NOT EXISTS specificity_level smallint;

CREATE TABLE IF NOT EXISTS public.rule_collision_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email_id uuid REFERENCES public.emails(id) ON DELETE CASCADE,
  level smallint NOT NULL,
  winner_rule_id uuid,
  winner_folder_id uuid,
  loser_rule_ids uuid[] NOT NULL DEFAULT '{}',
  folder_ids uuid[] NOT NULL DEFAULT '{}',
  reason text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.rule_collision_events TO authenticated;
GRANT ALL ON public.rule_collision_events TO service_role;

ALTER TABLE public.rule_collision_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own rule collision events"
  ON public.rule_collision_events
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS rule_collision_events_user_unresolved_idx
  ON public.rule_collision_events (user_id, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE TRIGGER update_rule_collision_events_updated_at
  BEFORE UPDATE ON public.rule_collision_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();