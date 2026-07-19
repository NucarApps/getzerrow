ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS parent_group_id uuid NULL
    REFERENCES public.contact_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contact_groups_parent_idx
  ON public.contact_groups(parent_group_id);

-- Prevent self-parenting at the DB layer (belt-and-suspenders; server also
-- validates full cycles).
ALTER TABLE public.contact_groups
  DROP CONSTRAINT IF EXISTS contact_groups_no_self_parent;
ALTER TABLE public.contact_groups
  ADD CONSTRAINT contact_groups_no_self_parent
    CHECK (parent_group_id IS NULL OR parent_group_id <> id);