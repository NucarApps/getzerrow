
CREATE TABLE public.contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'other',
  address text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contact_emails_contact_addr_uniq
  ON public.contact_emails (contact_id, lower(address));
CREATE INDEX contact_emails_user_addr_idx
  ON public.contact_emails (user_id, lower(address));
CREATE INDEX contact_emails_contact_id_idx
  ON public.contact_emails (contact_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_emails TO authenticated;
GRANT ALL ON public.contact_emails TO service_role;

ALTER TABLE public.contact_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own contact emails"
  ON public.contact_emails
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER contact_emails_set_updated_at
  BEFORE UPDATE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Mirror the primary email back to contacts.email so downstream code that
-- reads contacts.email keeps working unchanged.
CREATE OR REPLACE FUNCTION public.sync_contact_primary_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_id uuid;
  v_primary text;
BEGIN
  v_contact_id := COALESCE(NEW.contact_id, OLD.contact_id);
  SELECT address INTO v_primary
    FROM public.contact_emails
   WHERE contact_id = v_contact_id
   ORDER BY is_primary DESC, position ASC, created_at ASC
   LIMIT 1;
  UPDATE public.contacts
     SET email = v_primary,
         updated_at = now()
   WHERE id = v_contact_id
     AND email IS DISTINCT FROM v_primary;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER contact_emails_sync_primary
  AFTER INSERT OR UPDATE OR DELETE ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.sync_contact_primary_email();

-- Backfill: one row per existing contact that has an email.
INSERT INTO public.contact_emails (user_id, contact_id, label, address, is_primary, position)
SELECT c.user_id, c.id, 'other', lower(c.email), true, 0
  FROM public.contacts c
 WHERE c.email IS NOT NULL AND length(trim(c.email)) > 0
ON CONFLICT (contact_id, lower(address)) DO NOTHING;
