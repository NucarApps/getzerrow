ALTER TABLE public.contact_group_members
  ADD COLUMN IF NOT EXISTS auto_added boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS contact_group_members_group_auto_idx
  ON public.contact_group_members (group_id, auto_added);