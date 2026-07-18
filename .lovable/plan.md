## Problem

1. **AI group suggestions returns 0**: the prompt still says "at least 3 contact_ids", contradicting the loosened `minMembers=2`, and the model sees the whole contact list without any hint that many contacts are ungrouped — so it defers to existing groups and returns nothing.
2. **AI enrich only fills company from the email domain**: the scanner never opens the contact's mail history, so it can't find the real signature (title, phone, company as the person actually writes it).

## Plan

### 1. Focus group suggestions on ungrouped contacts

In `src/lib/contacts/suggest-groups.functions.ts`:

- Compute `ungroupedCount` and flag each contact line with `u: true` when it has no `g` memberships.
- Rewrite the prompt: minimum **2** contact_ids per suggestion (match the code), state how many contacts are ungrouped, and instruct the model to prioritize covering those first (by shared company, domain, city, or role).
- Sort `contactLines` so ungrouped contacts appear first, and if there are more than 800 contacts, cap the payload with all ungrouped + a sample of grouped ones (context, not targets).
- On a 0-result run, surface the ungrouped count in the toast (`Scanned N contacts (M ungrouped) — no suggestions`) so the user knows the pool was real.

### 2. Real enrichment from email signatures (name + phone + company + title)

Rewrite the enrichment scanner in `src/lib/contacts/enrich-suggest.functions.ts`:

- **For contacts that DO have an email**: pull recent messages from that sender via existing helpers (`emails.from_addr` → `getEmailsDecrypted`), send the decrypted subject/body snippets through an AI extraction step (Lovable AI gateway, `google/gemini-3.1-flash-lite`) with a small Zod schema of `{ name, title, company, phones[] }`. Convert each extracted field into a `contact_enrichment_suggestion` row when it differs from what's on file. Rate-limit to ~40 contacts per scan and cache signals so repeat scans skip contacts we already extracted from.
- **Company fallback**: keep the domain-derived company suggestion, but only when the AI extractor returned nothing — clearly labeled `source: domain_derived`, `confidence: low`.
- **For contacts WITHOUT an email**: keep the current name-based mail-participant match (already suggests an email + evidence).
- **Phones**: normalize with `normalizePhone`, dedupe against the contact's existing phones (via `contact_phones` join), only suggest new numbers.
- Insert only fields the contact is missing OR that clearly differ from the current value (never overwrite silently — always a `pending` suggestion the user approves).

### 3. UI feedback

`EnrichmentSuggestionsDrawer.tsx`: no schema change needed. Toast copy already reports `scanned` / `created`. Show a short "Powered by your inbox" hint under the description so the user knows the scan is reading their mail history.

## Technical notes

- AI schema stays small (no `.min()/.max()/enum` bounds on strings) to avoid gateway `too many states` errors; enforce limits in the prompt and clamp in code.
- Wrap the `generateText` call with `NoObjectGeneratedError.isInstance(error)` fallback that parses `error.text` as JSON — same defensive pattern used in group suggestions.
- Skip contacts whose `enriched_at` was updated in the last 24h to avoid duplicate AI calls per scan run.
- Log `enrich.contact_extracted` with counts of fields returned so we can debug empty runs.

## Files touched

- `src/lib/contacts/suggest-groups.functions.ts` — prompt + ordering.
- `src/lib/contacts/enrich-suggest.functions.ts` — AI-driven extraction path.
- `src/components/contacts/EnrichmentSuggestionsDrawer.tsx` — small hint text.

No new tables or migrations.
