## Fix "Alias must differ from primary" merge error

### Root cause
Both DCD/Nucar rows resolve to `nucar.com` but appear as two separate buckets (one keyed by domain, one keyed by `name:...` because some contacts have no email — just a website + manual company). The merge suggestion then tries to add `nucar.com` as an alias of itself, and the server-side validator (`company-aliases.functions.ts`) rejects it with the raw Zod error shown in the toast.

### Changes (all in `src/routes/_authenticated/contacts.index.tsx`, plus one small server tweak)

1. **Collapse same-domain buckets after construction** (`companyBuckets` memo)
   - After the current loop, do a second pass that merges any `name:*` bucket into an existing domain bucket when its contacts' website/email domain resolves to the same domain. This eliminates the duplicate Nucar row entirely for most cases.

2. **Guard the merge suggestion builder** (`mergeSuggestions` memo)
   - Deduplicate `aliasDomains` and drop any alias equal to `primaryDomain`.
   - If, after dedupe, there are no distinct alias domains left, switch the suggestion to a **rename-only** merge (new field `kind: "rename" | "alias"`).

3. **Handle rename-only merges** (`performMerge`)
   - For `kind: "rename"`, call the existing `renameCompanyForContacts` server fn on the alias bucket's contact IDs, setting them to the primary display name. No alias insert, no server error.
   - For `kind: "alias"`, keep today's behavior but skip any alias equal to primary as a safety net.

4. **Friendlier error surface** (`src/lib/company-aliases.functions.ts`)
   - Wrap the Zod refine failure to throw a plain `Error("Alias domain must differ from the primary domain")` instead of leaking the raw Zod issue array into the toast.

### Out of scope
No schema changes. No changes to Google Contacts sync or auto-subgroup reconcile.

### Verification
- Reload contacts page: the two Nucar rows collapse to one bucket (change 1). If any edge case still leaves two same-domain buckets, the "Merge" banner now works and renames instead of erroring (changes 2–3).
- Manually trigger a real cross-domain merge (e.g. Hyundai on two different domains) to confirm alias-based merges still work.
