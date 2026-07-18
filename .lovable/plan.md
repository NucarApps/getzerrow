## Goal
In the Contacts "By company" view, when two or more buckets share the same normalized company name but live on different email domains (e.g. two Honda dealers), surface a "Merge N companies?" suggestion in each affected bucket header. Clicking it collapses them into one bucket by writing the extra domains to `company_aliases`, so all downstream logic (tags, logos, sync) treats them as one company. No automatic writes.

## What changes

### 1. Company-name normalizer
Add `src/lib/contacts/company-name.ts` exporting `normalizeCompanyName(raw)`:
- Lowercase, trim, collapse whitespace.
- Strip trailing legal suffixes: `inc`, `inc.`, `llc`, `l.l.c.`, `ltd`, `co`, `co.`, `corp`, `corporation`, `gmbh`, `s.a.`, `s.a.s`, `pty`, `plc`, `bv`, `ag`, `kg`.
- Strip punctuation (`.,'"&/`), collapse multiple spaces.
- Return `null` for empty/1-char results (so we don't merge on garbage).

### 2. Suggest merges in the contacts view
In `src/routes/_authenticated/contacts.index.tsx`:
- Keep existing domain-keyed `companyBuckets` as-is.
- Add a new `useMemo` that walks `companyBuckets` (kind === "company"), derives the dominant `company` string per bucket (mode of `c.company` values, fallback to `bucket.name`), normalizes it, and groups bucket keys by that normalized name.
- Produce a `mergeSuggestions: Map<bucketKey, { normalizedName; displayName; otherBuckets: Bucket[] }>` for any name shared by ≥2 buckets.

### 3. Bucket header UI
Where each company bucket row is rendered (around lines 620–690), if `mergeSuggestions.has(b.key)`:
- Show a small inline chip: `Merge {N} "{displayName}" companies?` with a `Merge` button and a `Dismiss` button.
- Merge picks the bucket with the most contacts as primary (tiebreak: most emails, then alphabetical domain) and calls a new server fn `mergeCompaniesByName` with `{ primaryDomain, aliasDomains[] }`.
- Dismiss stores the normalized name in `localStorage` under `zerrow.mergeDismissed` so it stops nagging.

### 4. Server function
Add `mergeCompaniesByName` in `src/lib/contacts/company-merge.functions.ts` (auth-required via `requireSupabaseAuth`):
- Validate inputs (Zod: primary domain + non-empty aliases, all lowercase hostnames).
- For each alias domain, upsert into `company_aliases` (`user_id`, `alias_domain`, `primary_domain`) — reuses the existing table already read by `aliasMap`.
- Return `{ inserted: n }`.
Client-side: `useMutation` invalidates the `company_aliases` query so the buckets recollapse via the existing `aliasMap` path.

### 5. Nothing else changes
- Pencil / tags dialog, logos, filters, and Google/CardDAV sync all continue to work because they read `company_aliases`. No schema migration needed — the table exists.

## Technical notes
- Normalizer lives in `src/lib/contacts/` (pure, unit-testable). Add `company-name.test.ts` covering "Honda Inc.", "honda", "Honda  Motor Co", "Honda, LLC".
- Dominant name per bucket: iterate `bucket.contacts`, count non-empty `c.company` occurrences (case-insensitive), pick the highest; ignore buckets whose normalized name is `null`.
- Don't suggest merges across `kind !== "company"` (skip Personal / Other).
- Dismissed set is client-only (localStorage); persistence across devices isn't needed for a nudge.
- Keep `companyBuckets`'s existing memo dependency list intact; add the new memo separately so re-renders stay cheap.

## Out of scope
- No auto-merge, no writes without user click.
- No changes to the aliases dialog (existing pencil flow already lets users manage aliases manually).
- No changes to CardDAV/Google sync — they pick up merges via `company_aliases` automatically on next sync.
