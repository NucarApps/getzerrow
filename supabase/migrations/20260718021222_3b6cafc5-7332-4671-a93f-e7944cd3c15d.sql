
CREATE TABLE public.contact_enrichment_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  field text NOT NULL CHECK (field IN ('email','phone','company','title')),
  value text NOT NULL,
  source text NOT NULL,
  evidence text,
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_enrichment_suggestions TO authenticated;
GRANT ALL ON public.contact_enrichment_suggestions TO service_role;

ALTER TABLE public.contact_enrichment_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their enrichment suggestions"
  ON public.contact_enrichment_suggestions FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX contact_enrichment_suggestions_user_status_idx
  ON public.contact_enrichment_suggestions(user_id, status, created_at DESC);
CREATE INDEX contact_enrichment_suggestions_contact_idx
  ON public.contact_enrichment_suggestions(contact_id);
CREATE UNIQUE INDEX contact_enrichment_suggestions_dedup_idx
  ON public.contact_enrichment_suggestions(user_id, contact_id, field, value)
  WHERE status = 'pending';

CREATE TRIGGER contact_enrichment_suggestions_updated_at
  BEFORE UPDATE ON public.contact_enrichment_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
