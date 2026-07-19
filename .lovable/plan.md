## Problem

"Add people to company" (and the second-attempt add) fails with:

> there is no unique or exclusion constraint matching the ON CONFLICT specification

Root cause (verified via `pg_indexes`): `contacts` has no plain unique constraint on `(user_id, email)`. The only uniqueness on email is a partial functional index:

```
CREATE UNIQUE INDEX contacts_user_email_unique
  ON public.contacts (user_id, lower(email)) WHERE email IS NOT NULL;
```

PostgREST / supabase-js `upsert({ onConflict: "user_id,email" })` requires an index whose target list is exactly the named columns. Functional/partial indexes don't match, so every call throws — including the first "Find people" add and the retry after merging.

## Fix

Update `addCompanyPeople` in `src/lib/companies/company-people.functions.ts` to stop relying on `onConflict` and instead:

1. Normalize the incoming emails (already lowercased by Zod).
2. `SELECT id, email FROM contacts WHERE user_id = ? AND lower(email) IN (...)` to find which already exist.
3. For existing rows: `UPDATE` to set `company_id` and `company` (and `name` if currently null) — only for rows that don't already belong to another company (respect manual overrides / existing links, matching how the rest of the codebase treats company assignment).
4. For missing rows: plain `INSERT` (no upsert) with `user_id, email, name, company, company_id, source: 'email'`.
5. Collect all affected `contactIds` (inserted + updated) and pass them into the existing `syncCompanyRuleMemberships` and `reconcileAutoParentsForContacts` calls so labels/subgroups still converge.

This matches the existing partial-index semantics (case-insensitive email dedupe) and eliminates the ON CONFLICT dependency entirely — no schema migration needed.

## Files

- `src/lib/companies/company-people.functions.ts` — rewrite the `addCompanyPeople` handler body only. Public signature and validators unchanged.

## Out of scope

- No change to the schema or the partial unique index.
- No change to `findCompanyPeopleByDomain` or UI.
