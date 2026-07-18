
CREATE TABLE public.contact_revisions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  source TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contact_revisions_contact_idx ON public.contact_revisions (contact_id, created_at DESC);
CREATE INDEX contact_revisions_user_idx ON public.contact_revisions (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_revisions TO authenticated;
GRANT ALL ON public.contact_revisions TO service_role;

ALTER TABLE public.contact_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own contact revisions"
  ON public.contact_revisions FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
