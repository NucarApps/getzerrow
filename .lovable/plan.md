## Problem
On the company page, both logo previews (header monogram at the top and the thumbnail inside the Logo tab) render only from `photoUrl` (`companies.logo_url`) and the `primaryDomain`. The brand-logo picker (`CompanyLogoPicker`) saves a per-domain choice (`provider` + `source_domain`) into `company_logo_choices`, but the preview `<CompanyLogo>` calls never read that choice — so after selecting "24 Auto Group" the previews keep showing the "D" monogram (default provider on the primary domain fails to load, so it falls back to the initial).

Contact rows on the Contacts list already read `company-logo-choices` and pass `provider` / `sourceDomain` to `<CompanyLogo>` — the company page just isn't doing the same.

## Fix — `src/routes/_authenticated/contacts.companies.$companyId.tsx`

1. Load logo choices in the page component:
   - `import { listCompanyLogoChoices } from "@/lib/company-logo.functions"` (already used elsewhere).
   - Add `const choicesQ = useQuery({ queryKey: ["company-logo-choices"], queryFn: () => listChoices() })` next to the existing queries.
   - Derive `const choice = choicesQ.data?.find(c => c.domain === primaryDomain)` → `logoProvider = choice?.provider ?? null`, `logoSourceDomain = choice?.source_domain ?? null`.

2. Pass those into the two `<CompanyLogo>` previews:
   - Header preview (line 295): add `provider={logoProvider}` and `sourceDomain={logoSourceDomain}`.
   - `CompanyPhotoSection` thumbnail (line 940): extend the component's props with optional `provider` / `sourceDomain` and forward them; the parent (line 435) passes the derived values.

3. Keep existing `photoUrl` behavior — uploaded photo still wins over brand logo (matches `<CompanyLogo>`'s own precedence: `photoUrl` → provider/source brand logo → monogram).

No changes to picker save logic, no schema changes, no backend changes. `CompanyLogoPicker` already invalidates `["company-logo-choices"]` after a pick, so both previews will refresh instantly.

## Out of scope
Contacts list logos (already wired), CardDAV/Google push behavior, `logo_url` upload flow.
