-- 1. Merge orphan Factory group (unlinked, name='Factory' at top level) into the linked one, per user.
DO $$
DECLARE
  r RECORD;
  linked_id UUID;
BEGIN
  FOR r IN
    SELECT user_id, name
    FROM public.contact_groups
    WHERE parent_group_id IS NULL
    GROUP BY user_id, name
    HAVING COUNT(*) > 1
  LOOP
    SELECT g.id INTO linked_id
    FROM public.contact_groups g
    WHERE g.user_id = r.user_id
      AND g.parent_group_id IS NULL
      AND g.name = r.name
      AND EXISTS (SELECT 1 FROM public.google_group_links l WHERE l.contact_group_id = g.id)
    ORDER BY g.created_at ASC
    LIMIT 1;

    IF linked_id IS NULL THEN
      SELECT id INTO linked_id
      FROM public.contact_groups
      WHERE user_id = r.user_id AND parent_group_id IS NULL AND name = r.name
      ORDER BY created_at ASC
      LIMIT 1;
    END IF;

    -- Move memberships from orphans to the canonical group (ignore conflicts).
    INSERT INTO public.contact_group_members (group_id, contact_id, source, user_id)
    SELECT linked_id, m.contact_id, m.source, m.user_id
    FROM public.contact_group_members m
    JOIN public.contact_groups g ON g.id = m.group_id
    WHERE g.user_id = r.user_id
      AND g.parent_group_id IS NULL
      AND g.name = r.name
      AND g.id <> linked_id
    ON CONFLICT DO NOTHING;

    -- Reparent any subgroups from orphan to canonical.
    UPDATE public.contact_groups
    SET parent_group_id = linked_id, updated_at = now()
    WHERE user_id = r.user_id
      AND parent_group_id IN (
        SELECT id FROM public.contact_groups
        WHERE user_id = r.user_id AND parent_group_id IS NULL AND name = r.name AND id <> linked_id
      );

    -- Delete the orphan groups (their memberships have been migrated).
    DELETE FROM public.contact_groups
    WHERE user_id = r.user_id AND parent_group_id IS NULL AND name = r.name AND id <> linked_id;
  END LOOP;
END $$;

-- 2. When a parent group is renamed, bump children's updated_at so the next push
--    renames the "Parent - Child" label in Google.
CREATE OR REPLACE FUNCTION public.bump_child_groups_on_parent_rename()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE public.contact_groups
    SET updated_at = now()
    WHERE parent_group_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_child_groups_on_parent_rename ON public.contact_groups;
CREATE TRIGGER trg_bump_child_groups_on_parent_rename
AFTER UPDATE ON public.contact_groups
FOR EACH ROW
EXECUTE FUNCTION public.bump_child_groups_on_parent_rename();

-- 3. Backfill: force re-push of every linked contact so myContacts membership is
--    added, and force re-push of every nested group so labels get the parent prefix.
UPDATE public.google_contact_links SET last_synced_at = 'epoch'::timestamptz;
UPDATE public.contact_groups SET updated_at = now() WHERE parent_group_id IS NOT NULL;