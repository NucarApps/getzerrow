## Goal

Let the user pick which logo to display for a company when multiple sources return a valid image.

## Approach

Extend the existing pencil/merge dialog (`CompanyAliasesDialog`) with a "Logo" picker. The proxy already tries 7 providers in order; expose them individually so the UI can render a grid, and persist the user's choice per company.

## Backend

**Logo proxy** (`src/routes/api/public/logo.ts`):
- Accept optional `?provider=<index>` (0..N-1). When present, fetch only that single provider and return it (or 404). When absent, keep current "first that works" behavior.
- Export a small `LOGO_PROVIDERS` count constant via a sibling `logo-providers.ts` shared with the client so the UI knows how many slots to render (labels like "Clearbit", "Logo.dev", "DuckDuckGo", "Apple touch icon", "Favicon", "Google").

**New table** `public.company_logo_choices`:
- `user_id uuid`, `domain text`, `provider int`, `updated_at timestamptz`
- PK `(user_id, domain)`
- RLS: `auth.uid() = user_id` for all ops.

**Server functions** (`src/lib/company-logo.functions.ts`):
- `listLogoChoices()` → `{ domain, provider }[]` for current user.
- `setLogoChoice({ domain, provider })` → upsert.
- `clearLogoChoice({ domain })` → delete row (revert to auto).

## Client

**`src/lib/company-domains.ts`**:
- `logoCandidates(domain, size, provider?)` — when `provider` is a number, append `&provider=<n>`; otherwise unchanged.

**`src/components/contacts/CompanyLogo.tsx`**:
- Accept optional `provider?: number | null`. When set, request that specific provider (single URL, no fallback chain — falls back to monogram on error). When unset, current behavior.

**`src/routes/_authenticated/contacts.index.tsx`**:
- Add `useQuery(["company-logo-choices"])` → `Map<domain, provider>`.
- Pass `provider` to every `CompanyLogo` in the bucket header / list using the resolved primary domain.

**`CompanyAliasesDialog`**:
- New "Logo" section above "Other domains".
- Render a 6-tile grid: each tile is a `CompanyLogo` forced to a specific `provider` index plus an "Auto" tile (no provider) shown first and selected by default.
- Tiles that fail to load (proxy 404 for that provider) hide themselves so the user only sees what actually exists.
- Selecting a tile calls `setLogoChoice` (or `clearLogoChoice` for Auto), invalidates `["company-logo-choices"]`, and shows a check overlay on the selected tile.

## Out of scope

- No changes to how the contact-level avatar inside a bucket row is chosen (still uses the resolved company domain, which now respects the user's per-domain choice).
- No global "default provider" preference.
- No reordering or custom upload of logos.