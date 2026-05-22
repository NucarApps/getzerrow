# Fix: enrich loses last name + UI doesn't update after enrich

## Two separate bugs

### Bug 1 — Last name disappears on Re-enrich
In `enrichContact` (`src/lib/contacts.functions.ts`), when the user clicks Re-enrich (`force: true`), we overwrite `name` with whatever the AI returned. If signatures in the sampled emails only contain a first name (e.g. they sign off `"— John"` even though Gmail's `from_name` was `"John Federici"`), the AI returns `"John"` and we replace the better existing name `"John Federici"` with `"John"`.

**Fix (server-side):** when comparing a candidate `name` against the existing one, prefer the more complete value:
- Compute token count for both (split on whitespace).
- If the existing name has more tokens **and** the new name is a prefix/subset of the existing (e.g. existing `"John Federici"`, new `"John"` or `"john"`), keep existing.
- Otherwise, prefer the candidate that has more tokens. Only fall through to "overwrite because force=true" when the new value is genuinely at least as complete.

Same guard applied in `addContactFromEmail` extraction (which already only fills empty fields, but we'll add the prefix check for consistency).

### Bug 2 — Contact detail page doesn't refresh until manual reload
In `src/routes/_authenticated/contacts.$id.tsx`, the form is seeded from `q.data.contact` inside a `useEffect` whose dependency array is `[q.data?.contact?.id]`. After Re-enrich:
- `qc.invalidateQueries({ queryKey: ["contact", id] })` does refetch the contact.
- But the contact's `id` hasn't changed, so the effect never re-runs and the form keeps showing the pre-enrich values.

**Fix (client-side, single file):** widen the effect's dependency to also include `q.data?.contact?.enriched_at` (and `q.data?.contact?.updated_at` if present) so the form re-syncs whenever the row is refetched with new data. Also call `await q.refetch()` after `enrich(...)` (in addition to the invalidate) so the UI updates without waiting for the next render tick.

## Out of scope
- No realtime subscription wiring — point invalidation + refetch on the action that caused the change is enough here.
- No DB schema change.
- No changes to the list page (already sorts client-side from the server response).
