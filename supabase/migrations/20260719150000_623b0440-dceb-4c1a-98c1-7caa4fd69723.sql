-- Company-label dedup, phase 1 (no uniqueness yet — that lands in phase 2
-- after the duplicate backfill has run):
--
-- 1. contact_groups.name_key: generated normalized-name column so every
--    label carries the same mild dedupe key the companies table uses.
--    Generated (not backfilled) so renames — including auto-subgroup
--    renames — can never leave the key stale.
-- 2. A non-unique scoped index for collision reporting and resolver reads.
-- 3. CardDAV tombstone trigger: app-side group deletions (label merges,
--    stale auto-subgroup cleanup, user deletes) previously wrote NO
--    carddav_tombstones row — only the CardDAV DELETE handler did — so
--    sync-collection clients (iPhones) never saw the 404 for a merged
--    duplicate group and kept it forever. SECURITY DEFINER from day one:
--    the Google tombstone triggers shipped without it and aborted every
--    user-initiated delete (fixed in 20260719123000).

ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS name_key text
  GENERATED ALWAYS AS (public.normalize_company_name(name)) STORED;

-- Non-unique for now: existing duplicates must be merged before the unique
-- index can be created (phase 2). COALESCE folds NULL parents into a
-- sentinel so root-level labels are scoped together.
CREATE INDEX IF NOT EXISTS contact_groups_user_parent_name_key_idx
  ON public.contact_groups (
    user_id,
    COALESCE(parent_group_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name_key
  );

CREATE OR REPLACE FUNCTION public.record_carddav_group_tombstone()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.carddav_tombstones (user_id, resource_type, resource_id)
  VALUES (OLD.user_id, 'group', OLD.id)
  ON CONFLICT (user_id, resource_type, resource_id)
  DO UPDATE SET deleted_at = now();
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS record_carddav_group_tombstone_trigger ON public.contact_groups;
CREATE TRIGGER record_carddav_group_tombstone_trigger
  BEFORE DELETE ON public.contact_groups
  FOR EACH ROW EXECUTE FUNCTION public.record_carddav_group_tombstone();
