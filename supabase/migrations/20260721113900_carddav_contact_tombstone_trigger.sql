-- CardDAV tombstone trigger for CONTACT deletions.
--
-- 20260719150000 added this trigger for contact_groups after label merges
-- left phantom groups on iPhones, but plain contact deletions still wrote
-- NO carddav_tombstones row — only the CardDAV DELETE handler (iPhone-
-- initiated deletes) and the manual-merge path did. So a contact deleted
-- in the web app never produced the 404 that sync-collection clients need
-- to drop it, and stayed on synced iPhones until a full resync.
--
-- SECURITY DEFINER for the same reason as the group trigger: the deleting
-- role (authenticated user) only has INSERT via RLS on its own rows, and
-- the trigger must never abort a user-initiated delete.

CREATE OR REPLACE FUNCTION public.record_carddav_contact_tombstone()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.carddav_tombstones (user_id, resource_type, resource_id)
  VALUES (OLD.user_id, 'contact', OLD.id)
  ON CONFLICT (user_id, resource_type, resource_id)
  DO UPDATE SET deleted_at = now();
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS record_carddav_contact_tombstone_trigger ON public.contacts;
CREATE TRIGGER record_carddav_contact_tombstone_trigger
  BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.record_carddav_contact_tombstone();
