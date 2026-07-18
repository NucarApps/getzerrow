
ALTER TABLE public.company_domains
  ADD COLUMN IF NOT EXISTS discovered_from_contact_id uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS member_count integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS company_domains_discovered_from_idx
  ON public.company_domains(discovered_from_contact_id);

-- Trigger: contact.company_id set + primary email
CREATE OR REPLACE FUNCTION public.autolink_contact_company_domain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
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
  INSERT INTO public.company_domains (user_id, company_id, domain, source, discovered_from_contact_id, member_count)
  VALUES (NEW.user_id, NEW.company_id, v_domain, 'auto', NEW.id, 1)
  ON CONFLICT (user_id, domain) DO UPDATE
    SET member_count = public.company_domains.member_count + 1,
        discovered_from_contact_id = COALESCE(public.company_domains.discovered_from_contact_id, EXCLUDED.discovered_from_contact_id);
  RETURN NEW;
END;
$$;

-- Trigger: contact_emails secondary address added
CREATE OR REPLACE FUNCTION public.autolink_contact_email_to_company()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
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

  INSERT INTO public.company_domains (user_id, company_id, domain, source, discovered_from_contact_id, member_count)
  VALUES (v_user_id, v_company_id, v_domain, 'auto', NEW.contact_id, 1)
  ON CONFLICT (user_id, domain) DO UPDATE
    SET member_count = public.company_domains.member_count + 1,
        discovered_from_contact_id = COALESCE(public.company_domains.discovered_from_contact_id, EXCLUDED.discovered_from_contact_id);
  RETURN NEW;
END;
$$;

-- Full recompute for a company: rebuilds auto domains from current members'
-- primary + secondary emails, deduplicates, records the earliest introducer,
-- and refreshes member_count. Manual-source domains are preserved.
CREATE OR REPLACE FUNCTION public.discover_company_domains(p_company_id uuid, p_user_id uuid)
RETURNS TABLE(added integer, updated integer, total_auto integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_added integer := 0;
  v_updated integer := 0;
  v_total integer := 0;
BEGIN
  -- Verify caller owns the company (RLS + belt-and-braces).
  IF NOT EXISTS (
    SELECT 1 FROM public.companies
     WHERE id = p_company_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;

  WITH member_emails AS (
    -- Primary emails on contacts.
    SELECT c.id AS contact_id, c.email AS address, c.created_at
      FROM public.contacts c
     WHERE c.company_id = p_company_id
       AND c.user_id = p_user_id
       AND c.email IS NOT NULL
    UNION ALL
    -- Secondary addresses.
    SELECT ce.contact_id, ce.address, ce.created_at
      FROM public.contact_emails ce
      JOIN public.contacts c ON c.id = ce.contact_id
     WHERE c.company_id = p_company_id
       AND c.user_id = p_user_id
  ),
  extracted AS (
    SELECT
      contact_id,
      public.email_domain(address) AS domain,
      created_at
      FROM member_emails
  ),
  filtered AS (
    SELECT domain, contact_id, created_at
      FROM extracted
     WHERE domain IS NOT NULL
       AND NOT public.is_personal_email_domain(domain)
  ),
  per_domain AS (
    SELECT
      domain,
      COUNT(DISTINCT contact_id)::int AS member_count,
      (ARRAY_AGG(contact_id ORDER BY created_at ASC NULLS LAST))[1] AS first_contact
    FROM filtered
    GROUP BY domain
  ),
  upserted AS (
    INSERT INTO public.company_domains
      (user_id, company_id, domain, source, discovered_from_contact_id, member_count)
    SELECT p_user_id, p_company_id, pd.domain, 'auto', pd.first_contact, pd.member_count
      FROM per_domain pd
    ON CONFLICT (user_id, domain) DO UPDATE
      SET member_count = EXCLUDED.member_count,
          discovered_from_contact_id = COALESCE(
            public.company_domains.discovered_from_contact_id,
            EXCLUDED.discovered_from_contact_id
          ),
          -- Reassign a stray auto-domain to this company if the members now say so.
          company_id = CASE
            WHEN public.company_domains.source = 'auto'
             AND public.company_domains.company_id <> EXCLUDED.company_id
              THEN EXCLUDED.company_id
            ELSE public.company_domains.company_id
          END
    RETURNING (xmax = 0) AS inserted
  )
  SELECT
    COUNT(*) FILTER (WHERE inserted),
    COUNT(*) FILTER (WHERE NOT inserted)
    INTO v_added, v_updated
    FROM upserted;

  SELECT COUNT(*)::int INTO v_total
    FROM public.company_domains
   WHERE company_id = p_company_id AND user_id = p_user_id;

  RETURN QUERY SELECT v_added, v_updated, v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.discover_company_domains(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.discover_company_domains(uuid, uuid) TO authenticated;
