-- Companies-in-labels groundwork.
--
-- 1. contact_group_members.source: disambiguates who owns a membership row.
--    'manual'            — user-added, never touched by any engine
--    'rule'              — materialized by contact_group_rules (incl. the new
--                          "company is in this label" rules)
--    'company_subgroup'  — managed by the auto-company-subgroups reconciler
--    Backfill is exact today: only the reconciler ever wrote auto_added=true.
--    Invariant going forward: auto_added = (source <> 'manual').
ALTER TABLE public.contact_group_members
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'rule', 'company_subgroup'));

UPDATE public.contact_group_members SET source = 'company_subgroup' WHERE auto_added;

CREATE INDEX IF NOT EXISTS contact_group_members_group_source_idx
  ON public.contact_group_members (group_id, source);

-- 2. Migrate legacy company_group_assignments (keyed by primary_domain,
--    one-shot tagging) into company_id group rules — the single source of
--    truth for "company X is in label G". The table itself is kept for now;
--    application writes to it stop with this release.
INSERT INTO public.contact_group_rules (user_id, group_id, rule_type, value, auto_apply)
SELECT DISTINCT cga.user_id, cga.group_id, 'company_id', cd.company_id::text, true
FROM public.company_group_assignments cga
JOIN public.company_domains cd
  ON cd.user_id = cga.user_id AND cd.domain = cga.primary_domain
JOIN public.contact_groups g
  ON g.id = cga.group_id AND g.auto_generated_from_group_id IS NULL
ON CONFLICT (group_id, rule_type, value) DO NOTHING;
