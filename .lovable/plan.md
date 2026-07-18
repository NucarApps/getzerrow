## Problem

The database actually has **8 separate company records** for Nissan:

- Nissan North America (4 contacts) ← what you think of as "the" Nissan
- Nissan, Nissan-USA, Nissan-USA.com, Nissan Motor Acceptance Company, Nissan Northeast Region, Nissan Of Keene, Boch Nissan South (1 contact each)

Auto-company-subgroups faithfully creates one child label per distinct company record under the "Factory" parent, so the group list shows "Nissan", "Nissan North America", "Nissan Motor Acceptance Company", "Nissan-usa.com", etc. The labels are correct given the data — the underlying problem is duplicate company records, not the label engine.

## Goal

Give you a first-class way to consolidate near-duplicate companies so that (a) one canonical company owns the contacts, (b) alternate names live as aliases (so future enrichment/import doesn't recreate them), and (c) auto-generated subgroup labels collapse to a single label per canonical company.

## Plan

### 1. Alias-aware auto-subgroup bucketing
Update `src/lib/contacts/auto-company-subgroups.functions.ts` so contacts whose free-text `company` matches a `company_aliases` row bucket under the canonical `company_id` instead of a new string bucket. Pruning already removes empty legacy string buckets, so the "Nissan", "Nissan-USA" labels disappear once contacts move.

### 2. Duplicate-company detector + AI review
New server fn `findDuplicateCompanies` in `src/lib/companies/companies.functions.ts` that clusters companies by:
- normalized name similarity (existing `normalize.ts` + token overlap: "Nissan", "Nissan-USA", "Nissan North America" → one cluster)
- shared `company_domains` (nissan-usa.com, nissanusa.com)
- shared contact email domains

Optional AI pass (Gemini) reviews each cluster and proposes the canonical record + which entries are true duplicates vs. distinct entities (e.g. "Nissan Motor Acceptance Company" and "Boch Nissan South" are separate businesses — keep them; "Nissan", "Nissan-USA", "Nissan-USA.com" fold into "Nissan North America").

### 3. Bulk-merge UI
New drawer `CompanyDuplicatesDrawer.tsx` on `/contacts/companies` showing each cluster:
- proposed canonical (editable)
- checkbox per duplicate to include/exclude
- preview: N contacts reassigned, N domains merged, N subgroup labels removed
- "Merge cluster" runs existing `mergeCompanies` for each pair, promoting old names into `company_aliases` and triggering `reconcileAutoParentsForContacts`.

### 4. Prevention at write time
- `createCompany` / `updateCompany`: before insert, check `company_aliases` and normalized name against existing companies; if a match exists, offer "use existing" instead of creating a duplicate.
- Enrichment (`enrich.functions.ts`): when it would set `company` to a string that matches an alias of the contact's current canonical company, no-op instead of overwriting.

### 5. One-time cleanup for your Nissan cluster
After you approve the merges in the UI, the reconcile pass will:
- Reassign all 4 stray Nissan contacts to "Nissan North America" (or whichever canonical you pick)
- Delete the "Nissan", "Nissan-USA", "Nissan-USA.com" subgroups under Factory
- Keep "Nissan Motor Acceptance Company" and dealer entities (Boch Nissan South, Nissan Of Keene) as separate if AI/you flag them as distinct businesses
- Bump `resync_nonce` so iPhone CardDAV re-fetches the cleaned group set

## Technical details

Files touched:
- `src/lib/companies/companies.functions.ts` — add `findDuplicateCompanies`, `previewClusterMerge`, `mergeCluster`
- `src/lib/contacts/auto-company-subgroups.functions.ts` — alias-aware bucketing
- `src/lib/contacts/enrich.functions.ts` — alias-aware no-op guard
- `src/components/contacts/CompanyCombobox.tsx` — surface "did you mean <existing>?" when typing a near-match
- `src/routes/_authenticated/contacts.companies.index.tsx` — "Find duplicates" button + drawer
- New `src/components/contacts/CompanyDuplicatesDrawer.tsx`

No migrations needed — `companies`, `company_aliases`, `company_domains`, `contact_groups.auto_generated_from_group_id` already exist.

## One question before I build

For the Nissan cluster specifically, do you want me to treat these as separate businesses (keep them) or fold them into "Nissan North America"?

- **Fold into Nissan North America**: Nissan, Nissan-USA, Nissan-USA.com
- **Likely separate (keep)**: Nissan Motor Acceptance Company (financing arm), Boch Nissan South (dealer), Nissan Of Keene (dealer), Nissan Northeast Region (regional office)

I'll wire the AI suggester with that same convention (corporate parents fold; dealers/financing arms stay separate) unless you tell me otherwise.
