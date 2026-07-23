-- Security fix: discover_company_domains cross-tenant authorization.
--
-- The function is SECURITY DEFINER (bypasses RLS) and granted to
-- `authenticated`. It previously authorized against the *caller-supplied*
-- `p_user_id` argument rather than the session's `auth.uid()`:
--
--     IF NOT EXISTS (SELECT 1 FROM public.companies
--                     WHERE id = p_company_id AND user_id = p_user_id) ...
--
-- Because `p_user_id` is attacker-controlled, an authenticated user who knew
-- another tenant's company_id + user_id could pass those ids and drive
-- reads/writes against that tenant's contacts/company_domains, bypassing RLS.
--
-- Fix: reject any call whose `p_user_id` does not match `auth.uid()`, and
-- authorize the company ownership check against `auth.uid()`. Service-role
-- callers (auth.uid() IS NULL) are unaffected — none exist today, but keeping
-- the NULL case permissive preserves the option without weakening the client
-- path. All existing callers pass `p_user_id = <session user>` already
-- (src/lib/companies/companies.functions.ts), so legitimate use is unchanged.
--
-- Idempotent: CREATE OR REPLACE. Signature is preserved so callers/grants stay
-- valid.

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
  -- Authorization: the caller may only act as themselves. `auth.uid()` is the
  -- authenticated session's user; `p_user_id` is a plain argument and must not
  -- be trusted on its own (that was the cross-tenant IDOR). A NULL auth.uid()
  -- means a service-role/internal caller, which is already fully trusted.
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'forbidden: p_user_id does not match the authenticated user';
  END IF;

  -- Verify caller owns the company. Scoped to auth.uid() when present so the
  -- check can't be satisfied by naming another tenant's (company, owner) pair.
  IF NOT EXISTS (
    SELECT 1 FROM public.companies
     WHERE id = p_company_id
       AND user_id = COALESCE(auth.uid(), p_user_id)
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
