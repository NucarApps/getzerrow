## What's actually wrong

Looking at John Federici in the database:
- `contacts.name = "John"` (just first name)
- His emails have `from_name = "Federici, John"` (Last, First format) and bodies are mostly auto-reply legal disclaimers — there's no clean signature for the AI to mine.

Two real bugs:

1. **Last name never recovered.** `enrichContact` only looks at email body tails for signature data. Federici's emails are auto-replies / legal boilerplate, so the LLM returns just `"John"` (or null). `pickBetterName` then keeps the existing `"John"`. The obvious source of his full name — the `from_name` field `"Federici, John"`, which `normalizeName` already knows how to flip to `"John Federici"` — is never consulted.

2. **UI doesn't update until refresh.** After `runEnrich` we only invalidate `["contact", id]` and `await q.refetch()`. The contacts list query (`["contacts"]`) is never invalidated, so going back to the list shows stale data. And on the detail page itself, we throw away the fresh `updated` contact that `enrichContact` already returns and wait for a round-trip refetch — which can lag a render due to the form-reset `useEffect` deps.

## Fix

### 1. `src/lib/contacts.functions.ts` — use `from_name` as a name candidate in `enrichContact`

In the existing name-merging step (around lines 291–299), before applying `pickBetterName(contact.name, extracted.name)`, also derive a candidate from the most recent email's `from_name`:

- Already fetching `emails` for body samples — extend the `.select(...)` to include `from_name`.
- Compute `fromNameCandidate = normalizeName(emails?.[0]?.from_name ?? null)` (handles `"Federici, John"` → `"John Federici"`).
- Merge in order: `best = pickBetterName(contact.name, fromNameCandidate); best = pickBetterName(best, extracted.name);`
- If `best && best !== contact.name`, set `patch.name = best`.

Result: John's contact becomes `"John Federici"` on the next Re-enrich, with no other behavior change (pickBetterName still refuses to shrink a longer existing name).

### 2. `src/routes/_authenticated/contacts.$id.tsx` — instant UI update after Re-enrich

In `runEnrich`:
- After `await enrich(...)`, do `qc.setQueryData(["contact", id], (prev) => ({ contact: r.contact, recentEmails: prev?.recentEmails ?? [] }))` so the page reflects the new name/company/summary on the same tick. (`enrichContact` already returns the freshly updated row.)
- Also call `qc.invalidateQueries({ queryKey: ["contacts"] })` so the list page is fresh when the user navigates back.
- Keep the existing `invalidateQueries({ queryKey: ["contact", id] })` as a safety refresh.

Also broaden the form-reset `useEffect` deps to include `q.data?.contact?.name`, `…?.company`, `…?.title` so the visible inputs always re-sync when the underlying record changes — not only when `enriched_at`/`updated_at` change.

## Out of scope

- No DB migration. No changes to contact creation, listing logic, or the relationship-summary prompt.
- Not touching `pickBetterName` / `normalizeName` — they already do the right thing once they see `"Federici, John"`.
