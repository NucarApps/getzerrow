CREATE TABLE public.company_logo_choices (
  user_id uuid NOT NULL,
  domain text NOT NULL,
  provider integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, domain)
);

ALTER TABLE public.company_logo_choices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own logo choices"
ON public.company_logo_choices
FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);