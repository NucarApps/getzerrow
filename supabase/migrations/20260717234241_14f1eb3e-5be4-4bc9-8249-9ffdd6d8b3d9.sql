ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS auto_company_subgroups boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_generated_from_group_id uuid NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS contact_groups_auto_gen_idx
  ON public.contact_groups (user_id, auto_generated_from_group_id)
  WHERE auto_generated_from_group_id IS NOT NULL;