ALTER TABLE public.contact_group_members ADD COLUMN IF NOT EXISTS source text;
CREATE INDEX IF NOT EXISTS contact_group_members_source_idx ON public.contact_group_members (group_id, source);
NOTIFY pgrst, 'reload schema';