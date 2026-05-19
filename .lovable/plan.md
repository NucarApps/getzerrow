## Bug

When you click the arrow on a suggested domain to move it to a different folder, the chip vanishes (optimistic update), the server call succeeds, and then the chip reappears after the query refetches.

## Root cause

Suggested domains for a folder are computed from rows in `folder_examples` for that folder. A domain is hidden from the list only if there is already a `folder_filters` row on the **same (source) folder** with that domain.

`reassignDomainToFolder` correctly:
- adds a `domain` filter on the **destination** folder
- moves matching emails' `folder_id` to the destination
- best-effort syncs Gmail labels

But it never touches the source folder's `folder_examples` rows, and it doesn't add anything to the source's filter list (and shouldn't — the user said this domain does NOT belong here). So when `listFolderDomainSuggestions` recomputes, the same `from_addr` rows still produce the same domain bucket → it pops back into the suggestions.

## Fix

In `src/lib/gmail.functions.ts`, inside `reassignDomainToFolder.handler`, after the email move succeeds:

1. Delete `folder_examples` rows on the **source** folder whose `from_addr` ends in `@<domain>` (case-insensitive). This is the canonical "this domain doesn't belong to this folder" signal and matches how the suggestion list is derived.
2. Best-effort insert corresponding `folder_examples` rows on the **destination** folder (one row per moved email's `from_addr`) so the destination's learned signal reflects reality. Use `upsert` / ignore conflicts if a unique constraint exists; otherwise plain insert is fine — this is a learning hint, not a source of truth.

Step 1 is the actual bug fix. Step 2 keeps the learning data consistent with the move so the destination's own suggestions and AI rules stay accurate.

No client changes needed — the existing `invalidateQueries(["folder-domains", folder.id])` will then refetch a list that no longer contains the reassigned domain.

## Out of scope

- The `exampleCount` is part of the query key (`["folder-domains", folder.id, exampleCount]`). Deleting examples will change the count and naturally trigger a refetch under the new key — no extra invalidation needed.
- No UI changes; the optimistic removal already works, it just needs the server state to agree.
