## Symptom
Both `Hermes Boston` and `Palm Beach Hermes` still exist in the database with unchanged `updated_at`, so the merge either never ran server-side or threw and was reported as success by the UI. The user got a green "merged" toast anyway.

## Likely root cause (needs one verification step)
`mergeCluster` in `src/lib/companies/companies.functions.ts` wraps each `mergeCompaniesImpl` call in `try/catch` and **swallows the error**, only bumping a `failed` counter. It always resolves the mutation, so `CompanyDuplicatesDrawer` fires its success path — `toast.success("Merged 0 companies · reassigned 0 contacts")` — and the cluster stays on screen with the merge button still active. `mergeCompaniesImpl` itself (called from the company detail page) already verifies deletion and throws, so the drawer's cluster path is the only place a "silent success" is possible.

Verification before writing code: reproduce once by clicking Merge on the Hermes cluster with browser devtools open and confirm the server function returns `{ merged: 0, failed: 1 }` (or similar) while the UI still shows success.

## Fix

1. **`mergeCluster` (`src/lib/companies/companies.functions.ts`)**
   - Collect per-source errors instead of swallowing them: `errors: Array<{ sourceId, message }>`.
   - Return `{ merged, failed, movedContacts, errors }`.
   - Do not throw when some succeed; do throw when `merged === 0 && failed > 0` so the mutation reports failure.

2. **`CompanyDuplicatesDrawer` (`src/components/contacts/CompanyDuplicatesDrawer.tsx`)**
   - In `onSuccess`, if `r.failed > 0` show `toast.warning` naming the first failure reason; only show `toast.success` when `r.merged > 0 && r.failed === 0`.
   - Also invalidate `["companies", "duplicates"]` (not just `["companies"]`) so the cluster disappears on partial success.
   - Guard the confirm button: when the computed `foldIds` array is empty (canonical unchanged, all others unchecked), disable it and show a hint — prevents the "Merged 0" outcome entirely.

3. **Structured logging** — add a `console.warn("[mergeCluster] merge failed", { sourceId, targetId, message })` inside the catch so future silent failures show up in worker logs.

No schema changes, no changes to `mergeCompaniesImpl` (its verify-and-throw contract already works — the caller was hiding it).

## Out of scope
Manually cleaning up the two Hermes rows. Once the fix surfaces the real error we can decide whether they should merge; forcing a SQL merge before we know why the delete failed would just repeat the DHG situation.