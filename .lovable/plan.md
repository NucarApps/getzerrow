## Problems

1. **Enrichment re-suggests dismissed items**: `scanContactEnrichment` only dedupes against `status = 'pending'` suggestions. Dismissed rows (and cleared fields) get re-proposed every run — especially the domain-derived company fallback, which fires whenever `contact.company` is empty.
2. **No way to see/restore declines**: Dismissed suggestions disappear from the drawer, so accidental dismisses are unrecoverable.
3. **AI group suggestions feel shallow**: The prompt only sees name/company/title/domain/city. It never sees what the person actually emails about, so it can't cluster by real relationship (e.g. "Vendors — auto parts", "Recruiters", "Investors"). It also doesn't cross-reference existing contact groups' rationales.

## Plan

### 1. Remember declines in enrichment (`src/lib/contacts/enrich-suggest.functions.ts`)

- Load BOTH pending and dismissed suggestions into the `existing` dedupe set, keyed by `contact_id|field|value`. A dismissed `company = "Acme"` on contact X will never be re-suggested for X.
- For the low-confidence **domain-derived company** fallback, add a second guard: skip if ANY dismissed suggestion exists for `(contact_id, field='company', source='domain_derived')`, regardless of value — so clearing the company field doesn't re-trigger the same domain guess.
- Add an `undismissContactEnrichmentSuggestion` server fn that flips `status` back to `pending` (for the "restore" action).

### 2. Show dismissed list in the drawer (`src/components/contacts/EnrichmentSuggestionsDrawer.tsx`)

- Extend `listContactEnrichmentSuggestions` with an optional `{ status: 'pending' | 'dismissed' }` filter (default pending, preserves current behavior).
- Add a small tab / toggle in the drawer header: **Pending · Dismissed**. Dismissed tab shows the same rows with a "Restore" button (calls the new undismiss fn) instead of Apply/Dismiss.
- Keep grouping-by-contact identical.

### 3. Make AI group suggestions actually read the inbox (`src/lib/contacts/suggest-groups.functions.ts`)

- For each ungrouped (or lightly grouped) contact with an email, pull a compact **topic signal** from their recent inbox threads: top 3 subjects + a 200-char snippet of the most recent body, via the existing `searchEmailsParticipantsDecrypted` + `getEmailsDecrypted` helpers. Cap to ~60 contacts per run to bound cost.
- Bucket by `normalizeCompanyName(company)` first (so all Honda contacts share one signal blob), then attach an aggregated `topics` array to those `contactLines` entries.
- Also pass the **existing groups' rationales** (currently only names) so the model can suggest subgroups that fit the user's mental model.
- Rewrite the prompt to instruct the model to cluster by **relationship type inferred from topics** (vendor, client, recruiter, investor, personal, etc.), not just shared company/domain, and to prefer `subgroup` under an existing group when topics align.
- Log `contact_group_suggestions.topics_attached` count to confirm the enrichment ran.

### 4. UI feedback

- Group drawer toast already shows counts; append `topics_scanned: N` when >0 so the user can see the inbox scan happened.
- No schema changes. No migrations.

## Technical notes

- `contact_enrichment_suggestions` already has `status` with `dismissed`; no DB change needed for #1/#2.
- The domain-derived guard uses `source = 'domain_derived'` which is already written on the row.
- Topic extraction reuses the same encrypted-reader helpers as `enrich-suggest`; keep the per-contact fetch behind `Promise.all` with a small concurrency cap (10) to stay under the 30s server-fn window.
- Keep the AI model (`google/gemini-3.1-flash-lite`) and structured `Output.object` schema; only the prompt content and payload shape change.

## Files touched

- `src/lib/contacts/enrich-suggest.functions.ts` — dismissed-aware dedupe, domain-derived hard-mute, new `undismissContactEnrichmentSuggestion`, `status` param on list fn.
- `src/components/contacts/EnrichmentSuggestionsDrawer.tsx` — Pending / Dismissed tabs, Restore action.
- `src/lib/contacts/suggest-groups.functions.ts` — inbox topic signals, richer prompt, group rationales in payload.
- `src/components/contacts/GroupSuggestionsDrawer.tsx` — surface `topics_scanned` in toast (small).
