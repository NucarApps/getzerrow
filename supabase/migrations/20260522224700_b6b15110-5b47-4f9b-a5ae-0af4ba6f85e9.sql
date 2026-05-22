
-- Contacts table
CREATE TABLE public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  title TEXT,
  company TEXT,
  phone TEXT,
  website TEXT,
  linkedin TEXT,
  twitter TEXT,
  avatar_url TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'email',
  enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX contacts_user_email_unique ON public.contacts (user_id, lower(email));
CREATE INDEX contacts_user_id_idx ON public.contacts (user_id, created_at DESC);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own contacts" ON public.contacts
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- My Cards
CREATE TABLE public.my_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  handle TEXT NOT NULL UNIQUE,
  name TEXT,
  title TEXT,
  company TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  linkedin TEXT,
  twitter TEXT,
  avatar_url TEXT,
  tagline TEXT,
  theme TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX my_cards_handle_idx ON public.my_cards (lower(handle));

ALTER TABLE public.my_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own card" ON public.my_cards
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
-- Public read is handled via server fn with supabaseAdmin (safe column projection); no anon policy.

CREATE TRIGGER my_cards_updated_at BEFORE UPDATE ON public.my_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Sent card log
CREATE TABLE public.contact_cards_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  contact_id UUID,
  to_email TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contact_cards_sent_user_idx ON public.contact_cards_sent (user_id, sent_at DESC);

ALTER TABLE public.contact_cards_sent ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users access own sent log" ON public.contact_cards_sent
  FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
