# Fix flicker on "Suggested domains" + click

## Symptom
Clicking the + on a suggested domain makes the whole "Suggested domains" block disappear, the layout jumps up, then the block reappears (minus the clicked domain) and the layout jumps back down.

## Cause
In `FolderEditor` (src/routes/_authenticated/folders.tsx):
- `domainsQ` uses `queryKey: ["folder-domains", folder.id, exampleCount, filters.length]`.
- Clicking + inserts a filter → `folder-filters` query invalidates → `filters.length` changes → React Query sees a **new** key with no cache → `domainsQ.data` is `undefined` mid-flight → the `(domainsQ.data?.length ?? 0) > 0` guard unmounts the whole block.
- No optimistic update, so even fixing the key leaves a fetch-shaped gap.

## Fix (UI-only, `src/routes/_authenticated/folders.tsx`)
1. Drop `filters.length` from the `domainsQ` query key — the server already excludes existing filter domains, and we explicitly invalidate `folder-domains` after `addDomain`.
2. Add `placeholderData: (prev) => prev` to `domainsQ` so cached suggestions stay rendered during refetch.
3. In `addDomain`, optimistically remove the clicked domain from the cache with `qc.setQueryData` **before** awaiting the server call. Roll back on error.
4. Keep the existing post-success invalidations for `folder-filters` and `folder-domains`.

## Out of scope
- No server, schema, or business-logic changes.
- No change to learn / relearn flow.

## Verification
Click + on a domain chip: the chip disappears immediately, no layout jump, the remaining chips stay in place, and the new "domain contains" filter shows up in the Filters list above.
