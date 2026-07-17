
CREATE TABLE IF NOT EXISTS public.contact_duplicate_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  primary_contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  duplicate_contact_ids uuid[] NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  reason text,
  signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_duplicate_suggestions TO authenticated;
GRANT ALL ON public.contact_duplicate_suggestions TO service_role;

ALTER TABLE public.contact_duplicate_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own duplicate suggestions"
  ON public.contact_duplicate_suggestions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_contact_dup_suggestions_user_status
  ON public.contact_duplicate_suggestions (user_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contact_dup_suggestions_primary_pending
  ON public.contact_duplicate_suggestions (user_id, primary_contact_id)
  WHERE status = 'pending';

CREATE TRIGGER trg_contact_dup_suggestions_updated_at
  BEFORE UPDATE ON public.contact_duplicate_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
