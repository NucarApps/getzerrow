## Goal

Two changes so companies can't quietly share a domain, and so any collision becomes a merge prompt instead of a silent takeover:

1. Reject exact-domain collisions when adding a domain to a company, and surface the conflicting company.
2. Let the user merge the two companies in one click from that prompt, using the existing merge flow.

## Current state (verified)

- DB already has `UNIQUE (user_id, domain)` on `company_domains`, so two companies literally cannot both own `nissan.com`. `psql` shows zero duplicate rows today.
- `addCompanyDomain` in `src/lib/companies/companies.functions.ts` does `upsert(..., { onConflict: "user_id,domain" })`. That means if the domain is already on another company, the upsert **reassigns it silently** — the exact "two companies with the same domain" case the user wants blocked, plus a stealth data-loss risk.
- `findDuplicateCompanies` + `clusterCompanies` already unites companies by shared root domain, and `CompanyDuplicatesDrawer` + `mergeCluster` / `mergeCompanies` already do the merge. Nothing to build there — just plug the new flow into the same server fn.

## Changes

### 1. `addCompanyDomain` — return a structured conflict instead of stealing

- Look up any existing `company_domains` row for `(user_id, domain)` first.
- If it belongs to a **different** company: return `{ ok: false, conflict: { companyId, companyName, domain } }` without writing. No upsert.
- If it belongs to the **same** company: no-op success.
- Otherwise: plain insert with `source: 'manual'`.
- Same guard applied to the inline "create company" flow that also attaches a domain (`upsertBucketCompany` path around lines 186–210) — resolve to the existing company id when the domain is taken, or return the conflict so the caller can prompt.

### 2. UI: domain-conflict → merge prompt

In the company detail page's Domains section (`src/routes/_authenticated/contacts.companies.$companyId.tsx`):

- On `addCompanyDomain` success with `conflict`, open an `AlertDialog`:
  - "`example.com` is already assigned to **{other company}**. Two companies can't share a domain."
  - Primary action: "Merge {other} into {this}" → calls existing `previewMergeCompanies` for the diff summary, then `mergeCompanies({ sourceId: conflict.companyId, targetId: currentId })`, then invalidates queries.
  - Secondary: "Cancel" (leaves both untouched).
- Same dialog wired into `CompanyCombobox` inline-create when the domain path returns a conflict, so users hit the same merge affordance from the contact form.

### 3. No schema change

The existing unique constraint already enforces "one company per domain per user"; the fix is code + UX around it. No migration.

## Files touched

- `src/lib/companies/companies.functions.ts` — rewrite `addCompanyDomain` (and the inline attach path) to detect conflict instead of upserting.
- `src/routes/_authenticated/contacts.companies.$companyId.tsx` — wire the conflict dialog into the Domains section.
- `src/components/contacts/CompanyCombobox.tsx` — surface the same conflict → merge dialog when inline creation collides.
- `src/lib/companies/companies.functions.test.ts` (new small test) — unit-cover the "same company", "different company conflict", and "new insert" branches of `addCompanyDomain`.

## Out of scope

- Root-domain overlaps (parent vs subsidiary sharing `nissan.com` root but not the exact host) — already surfaced by the existing duplicate drawer; leaving alone since these are sometimes legitimate.
- Any change to `mergeCompanies` internals — it already handles domain, tag, contact, and label reconciliation.
