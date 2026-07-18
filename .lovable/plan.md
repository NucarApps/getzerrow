## Bug

`reconcileAutoCompanySubgroupsImpl` derives the represented-companies set only from each manual member's `contacts.company` field. When a parent group's manual members have no `company` value but are bucketed on the contacts page by their email domain (e.g. everyone at `nissan.com` with an empty company field), no keys are produced → no auto subgroups are created and no domain-siblings get pulled in.

The contacts UI already handles this case: domain-only buckets display via `prettyCompanyName(domain)`. The reconciler needs the same fallback.

## Fix

Update `src/lib/contacts/auto-company-subgroups.functions.ts` so the "represented companies" set and the "all matching contacts" scan both consider **email domain** as a fallback company signal.

1. **Load extra fields when reading parent members.** Also fetch `contacts.email` and `contacts.website` alongside `company`.
2. **Derive per-contact company keys** with a helper `contactCompanyKeys(contact, aliasMap)`:
   - If `company` is set → key = `normalizeCompanyName(company)`.
   - Else if the contact has a non-personal email/website domain (via `extractDomain` + `resolveCompanyDomain` + `isPersonalDomain` + `contactLogoDomain`) → key = `normalizeCompanyName(prettyCompanyName(domain))`.
   - A contact can contribute keys from both paths (rare, e.g. `company: "Nissan"` + email `@nissan.com` → same key after normalization, deduped).
3. **Represented keys** = union of keys across all manual members (using the new helper), plus a per-key `displayNames` bag: raw company strings when present, otherwise `prettyCompanyName(domain)`.
4. **Load candidate contacts** (step 3 in current code) with `id, company, email, website` for the whole user, not just `company IS NOT NULL`, then bucket by the same helper. Filter to `repKeys` before storing.
5. **Also load `company_aliases`** once so `resolveCompanyDomain` collapses alias domains (`nissan-motor.com` → `nissan.com`) to the same key.
6. Everything downstream — subgroup create/rename/delete, parent auto-member reconcile, per-subgroup membership reconcile — keeps working unchanged because it's driven by the key→contactIds map.

## Files

- Edit: `src/lib/contacts/auto-company-subgroups.functions.ts`
  - Add helper `deriveCompanyKey(contact, aliasMap)` returning `{ key, displayName } | null`.
  - Update `reconcileAutoCompanySubgroupsImpl` steps 1, 2, 3 as above.
  - Fetch alias map once at the top of the reconciler via `company_aliases` scoped to `user_id`.
- No schema changes. No UI changes. No changes to `reconcileAllAutoGroups` / triggers — they call the same impl.

## Out of scope

- Personal-email domains stay excluded (matches the contacts page bucketing).
- Buckets that still have no domain and no `company` (i.e. the "Other" bucket) remain excluded — a subgroup called "Other" isn't useful.
- No backfill migration needed; the next reconcile (on page load, membership change, or manual re-scan) picks up the new keys.
