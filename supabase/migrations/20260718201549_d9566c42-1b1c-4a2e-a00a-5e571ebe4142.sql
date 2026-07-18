
CREATE TABLE IF NOT EXISTS public.company_name_aliases (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name_key text NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_name_aliases TO authenticated;
GRANT ALL ON public.company_name_aliases TO service_role;

ALTER TABLE public.company_name_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own company_name_aliases"
  ON public.company_name_aliases FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS company_name_aliases_company_idx
  ON public.company_name_aliases(company_id);
