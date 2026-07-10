-- 1. contact_group_members: enforce that both the group and the contact
--    referenced by a membership row are owned by the same authenticated user.
DROP POLICY IF EXISTS "Users access own contact group members" ON public.contact_group_members;
CREATE POLICY "Users access own contact group members"
ON public.contact_group_members
FOR ALL
USING (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.contact_groups cg
    WHERE cg.id = contact_group_members.group_id
      AND cg.user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = contact_group_members.contact_id
      AND c.user_id = auth.uid()
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.contact_groups cg
    WHERE cg.id = contact_group_members.group_id
      AND cg.user_id = auth.uid()
  )
  AND EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = contact_group_members.contact_id
      AND c.user_id = auth.uid()
  )
);

-- 2. contact_phones: enforce that the referenced contact is owned by the
--    same authenticated user, not just that user_id matches.
DROP POLICY IF EXISTS "Users access own contact phones" ON public.contact_phones;
CREATE POLICY "Users access own contact phones"
ON public.contact_phones
FOR ALL
USING (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = contact_phones.contact_id
      AND c.user_id = auth.uid()
  )
)
WITH CHECK (
  auth.uid() = user_id
  AND EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = contact_phones.contact_id
      AND c.user_id = auth.uid()
  )
);

-- 3. sync_state: resolve the singleton-vs-per-user conflict. This table is
--    intended to hold one sync-state row per user, but the `id integer
--    default 1` singleton design collides with per-user RLS. Make user_id
--    the natural per-user primary key and drop the misleading singleton id.
ALTER TABLE public.sync_state DROP COLUMN IF EXISTS id;
ALTER TABLE public.sync_state ADD CONSTRAINT sync_state_pkey PRIMARY KEY (user_id);
