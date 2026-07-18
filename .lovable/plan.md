## Problem

When a company is renamed (e.g. "Volkswagen of North America" → "Volkswagen"), `updateCompany` propagates the new name to every linked `contacts.company` field, but the auto-generated **subgroup label** ("Volkswagen of North America") is derived from members' raw `company` strings and only recomputed when subgroup reconcile runs — which currently fires on membership/company edits from the contact side, not on a company rename. So Bryan Barks's contact says "Volkswagen" while the group he lives under still says "Volkswagen of North America".

## Change

In `src/lib/companies/companies.functions.ts` → `updateCompany` handler, after we sync `contacts.company` to the new name, collect the affected contact IDs and call the existing `reconcileAutoParentsForContacts(supabase, userId, ids)` helper.

That helper already:
- walks every parent group with `auto_company_subgroups=true`
- calls `reconcileAutoCompanySubgroupsImpl`, which recomputes each subgroup's display name via `pickDisplayName` (most-common raw `company` among members)
- renames the existing subgroup row in place (same `id`, same `carddav_uid`) so iPhone/CardDAV sees a rename, not a create+delete

No schema changes. No new UI. Rename-only path — direct company edits (adding a contact to a company, merges) already trigger reconcile through the contact-side code paths.

### Files touched

- `src/lib/companies/companies.functions.ts` — inside `updateCompany`, when `patch.name` is set:
  1. Change the `contacts` sync to `.select("id")` so we get the affected IDs back.
  2. `await reconcileAutoParentsForContacts(supabase, userId, ids)` (dynamic import to avoid circular deps).

### Out of scope

- Manually created (non-auto) groups keep their user-chosen names — those are not derived from company name and should not silently rename.
- CardDAV group-display-style formatting (Group — Company) already reads live company name at render time, so nothing to change there.
