CREATE TABLE public.company_group_assignments (
  user_id uuid NOT NULL,
  primary_domain text NOT NULL,
  group_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, primary_domain, group_id)
);

ALTER TABLE public.company_group_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own company group assignments"
ON public.company_group_assignments
FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_company_group_assignments_user_domain
  ON public.company_group_assignments (user_id, primary_domain);