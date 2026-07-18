## Problem

Auto company subgroups produce three labels for one Company entity:
`VW`, `Volkswagen`, `Volkswagen Group of America Inc.`

Root cause in `src/lib/contacts/auto-company-subgroups.functions.ts` → `deriveCompanyKey`:
the bucketing key is the normalized `contact.company` string (or a fallback email/website domain). It ignores `contacts.company_id`. So contacts linked to the same Company entity but with different `company` free-text values ("VW", "Volkswagen", "Volkswagen Group of America Inc.") each spawn their own subgroup, and domain-only contacts on a secondary domain (e.g. `vw.com` vs `vwoa.com`) form yet another.

## Fix

Make `company_id` the primary bucketing key, falling back to the current string/domain logic only when a contact has no `company_id`.

### Changes in `src/lib/contacts/auto-company-subgroups.functions.ts`

1. Extend `ContactShape` to include `company_id`. Update every `.select(...)` on `contacts` in this file (member load at line 133, all-contacts load at line 170) to include `company_id`.
2. In `deriveCompanyKey` (and its call sites), accept an optional `companyMap: Map<string, { name: string }>` keyed by company id:
   - If `contact.company_id` is present and in the map, return `{ key: "cid:" + company_id, displayName: company.name, rawCompany: company.name }`. This guarantees one bucket per Company entity and the label follows the canonical company name.
   - Otherwise, fall through to today's string/domain logic.
3. Before step 2 of `reconcileAutoCompanySubgroupsImpl`, load the set of company ids referenced by the parent's manual members plus all user contacts sharing those ids, then fetch `companies(id, name)` once and build `companyMap`.
4. Keep step 6's "delete stale" pass — after the change it will prune the two extra VW/Volkswagen Inc. subgroups on the next reconcile automatically.

### Trigger a one-time reconcile

Because the existing subgroups were created under the old keying, they need one reconcile pass to collapse:

- Call `reconcileAllAutoGroups` (already exposed) after deploy, or the user can hit the existing "Reconcile auto subgroups" affordance. No new server fn or migration required.

### Out of scope (call out, don't change)

- Manual (non-auto) groups the user created by hand named "VW" or "Volkswagen" are not touched — only rows with `auto_generated_from_group_id` are managed. If any of the three labels in the screenshot is a manual group, it will remain; I'll surface that in the UI response so the user can delete it if desired.

### Verification

- Unit-level: extend `src/lib/contacts/company-name.test.ts` (or a new sibling) with a case asserting that two contacts sharing `company_id` but different `company` strings produce a single bucket.
- Manual: on the Bryan Barks parent group, run reconcile and confirm only one "Volkswagen" subgroup remains, matching the Company entity's name.
