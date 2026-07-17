-- google_contact_links: 1:1 map between local contact and Google People resource
CREATE TABLE public.google_contact_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gmail_account_id uuid NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  resource_name text NOT NULL,
  etag text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gmail_account_id, contact_id),
  UNIQUE (gmail_account_id, resource_name)
);
CREATE INDEX google_contact_links_user_id_idx ON public.google_contact_links(user_id);
GRANT SELECT ON public.google_contact_links TO authenticated;
GRANT ALL ON public.google_contact_links TO service_role;
ALTER TABLE public.google_contact_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read their google contact links"
  ON public.google_contact_links FOR SELECT
  USING (auth.uid() = user_id);
CREATE TRIGGER trg_gcl_updated_at BEFORE UPDATE ON public.google_contact_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- google_group_links: 1:1 map between local contact_group and Google contactGroup label
CREATE TABLE public.google_group_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gmail_account_id uuid NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  contact_group_id uuid NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  resource_name text NOT NULL,
  etag text,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gmail_account_id, contact_group_id),
  UNIQUE (gmail_account_id, resource_name)
);
CREATE INDEX google_group_links_user_id_idx ON public.google_group_links(user_id);
GRANT SELECT ON public.google_group_links TO authenticated;
GRANT ALL ON public.google_group_links TO service_role;
ALTER TABLE public.google_group_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read their google group links"
  ON public.google_group_links FOR SELECT
  USING (auth.uid() = user_id);
CREATE TRIGGER trg_ggl_updated_at BEFORE UPDATE ON public.google_group_links
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- google_sync_state: per-account cursor and status
CREATE TABLE public.google_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gmail_account_id uuid NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  people_sync_token text,
  groups_sync_token text,
  last_full_sync_at timestamptz,
  last_incremental_at timestamptz,
  last_error text,
  last_pull_count integer NOT NULL DEFAULT 0,
  last_push_count integer NOT NULL DEFAULT 0,
  pending_bump boolean NOT NULL DEFAULT false,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_sync_state_user_id_idx ON public.google_sync_state(user_id);
GRANT SELECT ON public.google_sync_state TO authenticated;
GRANT ALL ON public.google_sync_state TO service_role;
ALTER TABLE public.google_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read their google sync state"
  ON public.google_sync_state FOR SELECT
  USING (auth.uid() = user_id);
CREATE TRIGGER trg_gss_updated_at BEFORE UPDATE ON public.google_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- google_contact_tombstones: local deletes to propagate upstream
CREATE TABLE public.google_contact_tombstones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gmail_account_id uuid NOT NULL REFERENCES public.gmail_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('contact', 'group')),
  resource_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_contact_tombstones_acct_idx ON public.google_contact_tombstones(gmail_account_id);
GRANT SELECT ON public.google_contact_tombstones TO authenticated;
GRANT ALL ON public.google_contact_tombstones TO service_role;
ALTER TABLE public.google_contact_tombstones ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read their google tombstones"
  ON public.google_contact_tombstones FOR SELECT
  USING (auth.uid() = user_id);

-- Trigger: when a local contact is deleted and had a Google link, record a tombstone
CREATE OR REPLACE FUNCTION public.record_google_contact_tombstone()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.google_contact_tombstones (user_id, gmail_account_id, kind, resource_name)
  SELECT l.user_id, l.gmail_account_id, 'contact', l.resource_name
    FROM public.google_contact_links l
   WHERE l.contact_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_contacts_google_tombstone
  BEFORE DELETE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.record_google_contact_tombstone();

CREATE OR REPLACE FUNCTION public.record_google_group_tombstone()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.google_contact_tombstones (user_id, gmail_account_id, kind, resource_name)
  SELECT l.user_id, l.gmail_account_id, 'group', l.resource_name
    FROM public.google_group_links l
   WHERE l.contact_group_id = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_contact_groups_google_tombstone
  BEFORE DELETE ON public.contact_groups
  FOR EACH ROW EXECUTE FUNCTION public.record_google_group_tombstone();