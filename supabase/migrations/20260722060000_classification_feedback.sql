-- Classification feedback (rules upgrade, task 12): one-tap "this was
-- wrong" from any executed_rules row. Reference/metadata only — the
-- note is user-authored (bounded in the app), never email content.
CREATE TABLE public.classification_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  executed_rule_id uuid REFERENCES public.executed_rules(id) ON DELETE CASCADE,
  correct_folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  note text CHECK (note IS NULL OR length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX classification_feedback_user_idx
  ON public.classification_feedback (user_id, created_at DESC);

ALTER TABLE public.classification_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY classification_feedback_owner ON public.classification_feedback
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, INSERT ON public.classification_feedback TO authenticated;
GRANT ALL ON public.classification_feedback TO service_role;
