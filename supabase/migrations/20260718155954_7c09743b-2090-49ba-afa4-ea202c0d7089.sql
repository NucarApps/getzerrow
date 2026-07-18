
-- Helper: normalize a company name for dedupe (lower, strip legal suffixes, collapse spaces).
CREATE OR REPLACE FUNCTION public.normalize_company_name(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT NULLIF(
    regexp_replace(
      regexp_replace(
        lower(trim(coalesce(p_name, ''))),
        '\s+(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|limited|co|co\.|corp|corp\.|corporation|gmbh|s\.a\.|sa|ag|plc|pty|pty\.|pvt|pvt\.)\s*$',
        '',
        'gi'
      ),
      '\s+', ' ', 'g'
    ),
    ''
  );
$$;

-- Personal-domain list (kept in sync with src/lib/company-domains.ts).
CREATE OR REPLACE FUNCTION public.is_personal_email_domain(p_domain text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(coalesce(p_domain, '')) IN (
    'gmail.com','googlemail.com','outlook.com','hotmail.com','live.com','msn.com',
    'yahoo.com','yahoo.co.uk','ymail.com','icloud.com','me.com','mac.com',
    'proton.me','protonmail.com','pm.me','aol.com','gmx.com','gmx.de','mail.com',
    'zoho.com','fastmail.com','tutanota.com','qq.com','163.com','126.com'
  );
$$;

-- Extract the domain from an email address.
CREATE OR REPLACE FUNCTION public.email_domain(p_email text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_email IS NULL OR position('@' in p_email) = 0 THEN NULL
    ELSE lower(trim(split_part(p_email, '@', 2)))
  END;
$$;

-- ============================================================
-- companies
-- ============================================================
CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  name_key text NOT NULL,
  website text,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  region text,
  postal_code text,
  country text,
  industry text,
  description text,
  linked_group_id uuid REFERENCES public.contact_groups(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_user_name_key_uniq UNIQUE (user_id, name_key)
);
CREATE INDEX companies_user_idx ON public.companies (user_id);
CREATE INDEX companies_linked_group_idx ON public.companies (linked_group_id) WHERE linked_group_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "companies owner all" ON public.companies
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE TRIGGER companies_set_updated_at
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================
-- company_domains
-- ============================================================
CREATE TABLE public.company_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  domain text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_domains_source_chk CHECK (source IN ('auto','manual')),
  CONSTRAINT company_domains_user_domain_uniq UNIQUE (user_id, domain)
);
CREATE INDEX company_domains_company_idx ON public.company_domains (company_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_domains TO authenticated;
GRANT ALL ON public.company_domains TO service_role;

ALTER TABLE public.company_domains ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_domains owner all" ON public.company_domains
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- company_tags
-- ============================================================
CREATE TABLE public.company_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_tags_uniq UNIQUE (company_id, tag)
);
CREATE INDEX company_tags_user_idx ON public.company_tags (user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_tags TO authenticated;
GRANT ALL ON public.company_tags TO service_role;

ALTER TABLE public.company_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_tags owner all" ON public.company_tags
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================
-- contacts.company_id
-- ============================================================
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS contacts_company_id_idx ON public.contacts (company_id);

-- ============================================================
-- Backfill: one company per distinct (user_id, normalize(name))
-- ============================================================
WITH picks AS (
  SELECT
    c.user_id,
    public.normalize_company_name(c.company) AS name_key,
    -- pick the most common casing as display name
    mode() WITHIN GROUP (ORDER BY trim(c.company)) AS display_name
  FROM public.contacts c
  WHERE c.company IS NOT NULL
    AND public.normalize_company_name(c.company) IS NOT NULL
  GROUP BY c.user_id, public.normalize_company_name(c.company)
)
INSERT INTO public.companies (user_id, name, name_key)
SELECT user_id, display_name, name_key
FROM picks
ON CONFLICT (user_id, name_key) DO NOTHING;

-- Link contacts to their company
UPDATE public.contacts c
   SET company_id = comp.id
  FROM public.companies comp
 WHERE c.company_id IS NULL
   AND c.company IS NOT NULL
   AND comp.user_id = c.user_id
   AND comp.name_key = public.normalize_company_name(c.company);

-- Seed company_domains from contact_emails (non-personal only)
INSERT INTO public.company_domains (user_id, company_id, domain, source)
SELECT DISTINCT
  c.user_id,
  c.company_id,
  public.email_domain(ce.address),
  'auto'
  FROM public.contacts c
  JOIN public.contact_emails ce ON ce.contact_id = c.id
 WHERE c.company_id IS NOT NULL
   AND ce.address IS NOT NULL
   AND public.email_domain(ce.address) IS NOT NULL
   AND NOT public.is_personal_email_domain(public.email_domain(ce.address))
ON CONFLICT (user_id, domain) DO NOTHING;

-- Also seed from contacts.email (legacy single-email column)
INSERT INTO public.company_domains (user_id, company_id, domain, source)
SELECT DISTINCT
  c.user_id,
  c.company_id,
  public.email_domain(c.email),
  'auto'
  FROM public.contacts c
 WHERE c.company_id IS NOT NULL
   AND c.email IS NOT NULL
   AND public.email_domain(c.email) IS NOT NULL
   AND NOT public.is_personal_email_domain(public.email_domain(c.email))
ON CONFLICT (user_id, domain) DO NOTHING;

-- Backfill website from a member's website when unambiguous
WITH candidates AS (
  SELECT c.company_id, c.user_id,
         array_agg(DISTINCT c.website) FILTER (WHERE c.website IS NOT NULL AND c.website <> '') AS sites
    FROM public.contacts c
   WHERE c.company_id IS NOT NULL
   GROUP BY c.company_id, c.user_id
)
UPDATE public.companies co
   SET website = ca.sites[1]
  FROM candidates ca
 WHERE co.id = ca.company_id
   AND ca.sites IS NOT NULL
   AND array_length(ca.sites, 1) = 1
   AND (co.website IS NULL OR co.website = '');

-- Merge existing company_aliases (alias domain -> primary domain).
-- If we have a company for the primary domain (via any member email), copy the alias
-- as a manual domain onto that same company.
INSERT INTO public.company_domains (user_id, company_id, domain, source)
SELECT DISTINCT ca.user_id, cd.company_id, ca.alias_domain, 'manual'
  FROM public.company_aliases ca
  JOIN public.company_domains cd
    ON cd.user_id = ca.user_id AND cd.domain = ca.primary_domain
ON CONFLICT (user_id, domain) DO NOTHING;

-- Copy company_profiles descriptions:
--   key_type = 'name' -> match on name_key
--   key_type = 'domain' -> match on any company that owns that domain
UPDATE public.companies co
   SET description = cp.description
  FROM public.company_profiles cp
 WHERE cp.user_id = co.user_id
   AND cp.key_type = 'name'
   AND public.normalize_company_name(cp.key_value) = co.name_key
   AND (co.description IS NULL OR co.description = '');

UPDATE public.companies co
   SET description = cp.description
  FROM public.company_profiles cp
  JOIN public.company_domains cd
    ON cd.user_id = cp.user_id AND cd.domain = lower(cp.key_value)
 WHERE cp.user_id = co.user_id
   AND cp.key_type = 'domain'
   AND cd.company_id = co.id
   AND (co.description IS NULL OR co.description = '');

-- ============================================================
-- Trigger: auto-attach a contact's email domain to its company
-- ============================================================
CREATE OR REPLACE FUNCTION public.autolink_contact_email_to_company()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
  v_domain text;
BEGIN
  SELECT c.user_id, c.company_id
    INTO v_user_id, v_company_id
    FROM public.contacts c
   WHERE c.id = NEW.contact_id;

  IF v_company_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_domain := public.email_domain(NEW.address);
  IF v_domain IS NULL OR public.is_personal_email_domain(v_domain) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.company_domains (user_id, company_id, domain, source)
  VALUES (v_user_id, v_company_id, v_domain, 'auto')
  ON CONFLICT (user_id, domain) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER contact_emails_autolink_company
  AFTER INSERT OR UPDATE OF address ON public.contact_emails
  FOR EACH ROW EXECUTE FUNCTION public.autolink_contact_email_to_company();

-- Also trigger from contacts.email direct writes and when company_id is set
CREATE OR REPLACE FUNCTION public.autolink_contact_company_domain()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text;
BEGIN
  IF NEW.company_id IS NULL OR NEW.email IS NULL THEN
    RETURN NEW;
  END IF;
  v_domain := public.email_domain(NEW.email);
  IF v_domain IS NULL OR public.is_personal_email_domain(v_domain) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.company_domains (user_id, company_id, domain, source)
  VALUES (NEW.user_id, NEW.company_id, v_domain, 'auto')
  ON CONFLICT (user_id, domain) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contacts_autolink_company_domain
  AFTER INSERT OR UPDATE OF company_id, email ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.autolink_contact_company_domain();
