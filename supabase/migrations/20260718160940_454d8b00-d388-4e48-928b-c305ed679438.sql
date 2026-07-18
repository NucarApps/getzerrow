
CREATE OR REPLACE FUNCTION public.discover_company_domains(p_company_id uuid, p_user_id uuid)
RETURNS TABLE(added integer, updated integer, total_auto integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_added integer := 0;
  v_updated integer := 0;
  v_total integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.companies
     WHERE id = p_company_id AND user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Company not found';
  END IF;

  WITH member_emails AS (
    SELECT c.id AS contact_id, c.email AS address, c.created_at
      FROM public.contacts c
     WHERE c.company_id = p_company_id
       AND c.user_id = p_user_id
       AND c.email IS NOT NULL
    UNION ALL
    SELECT ce.contact_id, ce.address, ce.created_at
      FROM public.contact_emails ce
      JOIN public.contacts c ON c.id = ce.contact_id
     WHERE c.company_id = p_company_id
       AND c.user_id = p_user_id
  ),
  extracted AS (
    SELECT contact_id, public.email_domain(address) AS domain, created_at
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
