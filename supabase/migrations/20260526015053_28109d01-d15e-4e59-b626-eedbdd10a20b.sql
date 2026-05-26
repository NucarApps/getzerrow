-- Address fields on contacts
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS country text;

-- Multiple phones per contact
CREATE TABLE IF NOT EXISTS public.contact_phones (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'mobile',
  number text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_phones_contact_id ON public.contact_phones(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_phones_user_id ON public.contact_phones(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_phones_one_primary
  ON public.contact_phones(contact_id) WHERE is_primary;

ALTER TABLE public.contact_phones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own contact phones"
  ON public.contact_phones
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER set_contact_phones_updated_at
  BEFORE UPDATE ON public.contact_phones
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Backfill: copy existing single phone into the new table
INSERT INTO public.contact_phones (user_id, contact_id, label, number, is_primary, position)
SELECT user_id, id, 'mobile', trim(phone), true, 0
  FROM public.contacts
 WHERE phone IS NOT NULL AND trim(phone) <> ''
ON CONFLICT DO NOTHING;