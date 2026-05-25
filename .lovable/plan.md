## Goal

Let users merge multiple email domains under a single company on the Contacts page. Adding `acme.io` as an alias of `acme.com` should:
- Show those contacts in one company bucket
- Use the primary domain for the logo
- Persist per user, surviving reloads and applying everywhere we group by company

## UX

On each company bucket header, add a small "Edit" (pencil) button next to the chevron. Clicking opens a modal:

```
Acme
─────────────────────────────────
Primary domain
  acme.com                 (read-only chip)

Other domains for this company
  acme.io                  [x]
  acmehq.co                [x]
  + Add domain  [______________] [Add]

Logo
  Uses the primary domain.

[ Delete merge ]              [ Cancel ] [ Save ]
```

Rules:
- Primary domain is the bucket's current domain — you can't change it here (rename "Acme" itself stays out of scope; user can still rename via the company name elsewhere later).
- Adding a domain that's already the primary of another existing bucket immediately merges that bucket into this one.
- Aliases are validated as plain domains (`a.b` shape, no scheme/path), lowercased, deduped, and personal domains (gmail, etc.) are rejected with an inline error.
- "Delete merge" removes all aliases for this company (contacts go back to their own buckets).
- The Personal and Other buckets do not get an Edit button.

## Data

New table `public.company_aliases`:
- `user_id uuid` — owner
- `primary_domain text` — canonical company domain (lowercased)
- `alias_domain text` — extra domain that should resolve to `primary_domain`
- `created_at timestamptz`
- PK `(user_id, alias_domain)` so a domain can only alias to one company per user
- Index `(user_id, primary_domain)` for fast lookup

RLS: standard `auth.uid() = user_id` for ALL.

No changes to the `contacts` table — aliases live as a side mapping so they apply retroactively without rewriting rows.

## Server functions (`src/lib/company-aliases.functions.ts`)

All `createServerFn` + `requireSupabaseAuth`, Zod-validated:

- `listCompanyAliases()` → `Array<{ primary_domain, alias_domain }>` for the current user.
- `addCompanyAlias({ primaryDomain, aliasDomain })` — validates both as non-personal domains, rejects self-alias, upserts the row. If `aliasDomain` is currently the `primary_domain` of other alias rows, re-point those rows to the new primary (cascading merge).
- `removeCompanyAlias({ aliasDomain })` — delete the row.
- `clearCompanyAliases({ primaryDomain })` — delete all rows for that primary (used by "Delete merge").

## Client wiring

- `src/lib/company-domains.ts`: add a small helper `resolveCompanyDomain(domain, aliasMap)` that returns `aliasMap.get(domain) ?? domain`. Pure, easy to unit-test.
- `src/routes/_authenticated/contacts.index.tsx`:
  - Add a `useQuery(['company-aliases'])` calling `listCompanyAliases`.
  - Build `aliasMap: Map<aliasDomain, primaryDomain>` from the result.
  - In `companyBuckets`: when computing the bucket key for an email's domain `d`, use `resolveCompanyDomain(d, aliasMap)` as the key, name source, and logo domain.
  - Pass `onEdit` + the set of current aliases for each bucket into `CompanyBucketHeader`.
- New `src/components/contacts/CompanyAliasesDialog.tsx`: the modal described above; uses `useMutation` for add/remove/clear and invalidates `['company-aliases']` + `['contacts']`.
- `CompanyBucketHeader`: add a pencil button (only when `kind === "company"`) that fires the new `onEdit` callback. Clicking the pencil does NOT toggle the bucket.

## Out of scope

- Renaming the company display name itself.
- Editing per-contact company text from this dialog (still done in the contact drawer).
- Org-wide / cross-user shared aliases — this is per-user only.
- Auto-suggesting merges ("these two look similar?") — explicit user action only.
