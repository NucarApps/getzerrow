## What's going wrong

Aditya's avatar is a white circle with a black "N" — that's logo.dev's generic monogram placeholder, not the Nissan logo. Confirmed from the DB:

- Contact linked to company **Nissan Northeast Region** (`272ff8eb…`).
- That company has two domains: `nissanusa.com` (source=manual, 1 member) and `nissan-usa.com` (source=auto, 32 members).
- `getContact` orders domains by `source DESC, member_count DESC`, so it returns `nissanusa.com` as the effective logo domain.
- You already picked a logo for this company — `company_logo_choices` has a row with `domain='nissan-usa.com'`, `source_domain='nissanusa.com'`, `provider=0`. That row is what tells the UI "when rendering `nissan-usa.com`, fetch the logo from `nissanusa.com` via logo.dev."
- `ContactPhotoUploader` looks up the choice with `choices.find(c => c.domain === logoDomain)`. Since `logoDomain` is `nissanusa.com` but the choice is keyed by `nissan-usa.com`, the lookup **misses**, no `provider`/`sourceDomain` is passed, and `CompanyLogo` falls back to the default provider fanout against `nissanusa.com` — logo.dev doesn't index that host and serves the "N" placeholder.

The "Fix company logo photos" button only clears personal `avatar_url` rows so the company logo can show through; it doesn't touch this choice/domain mismatch, which is why running it changed nothing.

## Fix

Make the saved logo choice authoritative for the whole company, regardless of which of the company's domains "wins" the primary sort.

1. **`getContact` (`src/lib/contacts/crud.functions.ts`)** — after resolving `linkedCompanyId`, join `company_logo_choices` for the current user against every domain of that company. If any of the company's domains has a choice, return that choice's `source_domain` (falling back to `domain`) as `companyDomain`. Only when no choice exists do we fall back to the current manual > auto > member_count ordering.

2. **`ContactPhotoUploader` (`src/components/contacts/ContactPhotoUploader.tsx`)** — broaden the match so a choice is picked when *either* `c.domain === logoDomain` *or* `c.source_domain === logoDomain`. Defence-in-depth for callers that don't go through the new server-side resolution.

3. **Consistency for other surfaces** — apply the same broadened match in `CompanyBucketHeader.tsx` (contacts list header) and anywhere else that keys off `logoChoicesQuery.data.find(c => c.domain === …)`. Grep confirms these are the only two call sites.

4. **Small back-fill of ordering signal** — no schema change. When a `company_logo_choices` row exists whose `source_domain` matches one of the company's `company_domains.domain`, we still let `getContact` short-circuit to that source domain, so the "manual" duplicate `nissanusa.com` row doesn't need to be deleted.

## Verification

- Reload Aditya's contact drawer: the `nissanusa.com` logo should now be served via logo.dev's `?token=` route (`provider=0`, `sourceDomain='nissanusa.com'`) and render the red Nissan mark.
- Erica (Fenway Sports Group) and any other contact whose saved logo choice used a different `source_domain` than the company's top-sorted primary domain should also self-heal on next render.
- Contacts with no `company_logo_choices` row keep today's behaviour (manual > auto > member_count).

## Out of scope

No new tables/columns; no changes to the "Fix company logo photos" cleanup; no changes to the logo proxy or CardDAV echo guard.
