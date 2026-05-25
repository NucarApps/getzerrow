CREATE TABLE public.company_aliases (
  user_id uuid NOT NULL,
  primary_domain text NOT NULL,
  alias_domain text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, alias_domain),
  CHECK (primary_domain <> alias_domain),
  CHECK (primary_domain = lower(primary_domain)),
  CHECK (alias_domain = lower(alias_domain))
);

CREATE INDEX idx_company_aliases_user_primary
  ON public.company_aliases (user_id, primary_domain);

ALTER TABLE public.company_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own company aliases"
  ON public.company_aliases
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);