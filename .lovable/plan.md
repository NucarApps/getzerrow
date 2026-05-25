Add logo.dev brand-name search to the company logo picker.

**Backend**
- Add `LOGO_DEV_SECRET` (sk_...) secret.
- New server fn `searchLogoBrands({ query })` in `src/lib/logo-search.functions.ts`. Calls `https://api.logo.dev/search?q=…` with `Authorization: Bearer ${process.env.LOGO_DEV_SECRET}`, 4s timeout. Returns `{ results: { name, domain }[] }` capped at 10. Returns empty array on any error.

**UI — `CompanyAliasesDialog`**
- New "Search logos by name" section at the top of the Logo block. Debounced (300 ms) input pre-filled with the company name.
- Renders results as selectable tiles using the existing `/api/public/logo?domain={brand.domain}&provider=0` proxy.
- Picking a result calls existing `setCompanyLogoChoice({ domain: primaryDomain, provider: 0, sourceDomain: brand.domain })` — `source_domain` already drives display across `CompanyLogo`, bucket header, and contact rows.
- No alias added automatically.