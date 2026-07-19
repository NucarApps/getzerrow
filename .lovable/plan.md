
## What I found

- Both companies still exist for your user: **DHG** (`c1ee3cd9…`) and **Forvis** (`3b6e9a05…`), each with `updated_at = created_at` (never touched since creation).
- Buddy Dearman's contact still has `company_id = DHG` (with the free-text `company` field oddly set to "Forvis").
- If `mergeCompaniesImpl` had actually run for DHG → Forvis (or vice versa), the very first step re-points contacts' `company_id`, so Buddy would no longer be linked to DHG. That step never ran.

So one of two things happened:
1. The merge server function threw partway through (e.g., in `reconcileAutoParentsForContacts` or `syncCompanyRuleMemberships`) and the error toast was misread as success, **or**
2. Only the "Preview merge…" dialog opened and "Confirm merge" was never actually clicked / never resolved.

I need to fix your data now, and instrument the merge so we can see why it silently failed next time.

## Plan

### 1. Clean up your data (one-off)
- Merge DHG into Forvis directly:
  - Re-point `contacts.company_id` from DHG → Forvis (also set `company = 'Forvis'`).
  - Move any `company_domains`, `company_tags`, `company_logo_hashes`, `company_name_aliases` rows from DHG → Forvis (dedup on the existing unique constraints).
  - Add `DHG` / `dhg` as a `company_name_aliases` row pointing to Forvis so any future free-text "DHG" contact snaps to Forvis.
  - Re-point any `contact_group_rules` with `rule_type='company_id'` and `value=DHG` to Forvis (or delete if Forvis already has one).
  - Delete the DHG company row.
- Run `reconcileAutoParentsForContacts` on the moved contacts so their auto-company subgroup labels update.

### 2. Make the merge failure visible so we can fix root cause
- Wrap the post-move reconcile steps (`reconcileAutoParentsForContacts`, `syncCompanyRuleMemberships`, `discover_company_domains`) in `mergeCompaniesImpl` so that a failure there is **logged with structured detail** and does not swallow the reason — but still lets the delete step run when the failure is in a best-effort cleanup, so the source row is actually removed.
- After the source-delete, re-select the source id and if it still exists, throw a clear error like `"Merge did not delete DHG (id=…): <reason>"` instead of returning `ok: true`.
- In the UI mutation (`contacts.companies.$companyId.tsx`), on `onSuccess` also verify (via the invalidated `companies` list) that the source no longer exists before showing the success toast; otherwise show the returned message.

### 3. Verify
- Reload the Contacts / Companies list — confirm DHG is gone and Buddy Dearman shows Forvis with the correct logo.
- Re-run a merge on any other duplicate to confirm the new error path surfaces real reasons instead of silently leaving both rows behind.

### Technical notes
- Data cleanup runs via the insert-tool (UPDATE/DELETE) inside a single transactional SQL block; nothing in schema needs to change.
- Server change is confined to `src/lib/companies/companies.functions.ts` (`mergeCompaniesImpl` return + logging). UI change is confined to the merge mutation's `onSuccess` handler in `src/routes/_authenticated/contacts.companies.$companyId.tsx`.
- No RLS or grants change.
