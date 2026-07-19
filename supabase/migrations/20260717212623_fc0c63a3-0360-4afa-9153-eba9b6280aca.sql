
-- 1. New columns on contact_groups
ALTER TABLE public.contact_groups
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS carddav_uid text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill carddav_uid + make it stable + unique per user
UPDATE public.contact_groups
   SET carddav_uid = 'group-' || id::text
 WHERE carddav_uid IS NULL;

ALTER TABLE public.contact_groups
  ALTER COLUMN carddav_uid SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contact_groups_user_carddav_uid_key
  ON public.contact_groups (user_id, carddav_uid);

-- At most one group linked to any given folder
CREATE UNIQUE INDEX IF NOT EXISTS contact_groups_folder_id_unique
  ON public.contact_groups (folder_id)
  WHERE folder_id IS NOT NULL;

-- Keep updated_at fresh on any group row edit
DROP TRIGGER IF EXISTS trg_contact_groups_updated_at ON public.contact_groups;
CREATE TRIGGER trg_contact_groups_updated_at
  BEFORE UPDATE ON public.contact_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2. Membership changes bump the parent group's updated_at so iOS ETag flips
CREATE OR REPLACE FUNCTION public.bump_contact_group_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.contact_groups
     SET updated_at = now()
   WHERE id = COALESCE(NEW.group_id, OLD.group_id);
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_contact_group_members_bump ON public.contact_group_members;
CREATE TRIGGER trg_contact_group_members_bump
  AFTER INSERT OR DELETE OR UPDATE ON public.contact_group_members
  FOR EACH ROW EXECUTE FUNCTION public.bump_contact_group_updated_at();
