
CREATE TABLE public.contact_groups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contact_groups_user_name_idx ON public.contact_groups (user_id, lower(name));

ALTER TABLE public.contact_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own contact groups"
  ON public.contact_groups FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER contact_groups_updated_at
BEFORE UPDATE ON public.contact_groups
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.contact_group_members (
  group_id UUID NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, contact_id)
);
CREATE INDEX contact_group_members_contact_idx ON public.contact_group_members (contact_id);
CREATE INDEX contact_group_members_user_idx ON public.contact_group_members (user_id);

ALTER TABLE public.contact_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own contact group members"
  ON public.contact_group_members FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
