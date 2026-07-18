# Stop enrichment from overwriting fields you manually edited

## Problem
When you edit a contact's name or company and later run "Enrich" (single or the batch "Rerun for everyone"), the AI can replace your edit:
- `enrichContact` picks a "better" name via `pickBetterName(contact.name, fromNameCandidate)` — a signature-derived name can beat yours.
- Batch/force runs use `data.force`, which flips the "only fill empty fields" guard off and lets AI overwrite `company`, `title`, `website`, etc. even when you've set them.
- Nothing today records that a field was set by *you* vs. by AI, so enrichment can't tell the difference.

## Fix

Track which fields are user-owned and treat them as locked during enrichment.

1. **Schema** — add `contacts.manual_overrides text[] not null default '{}'`. Values are field names like `name`, `company`, `title`, `phone`, `website`, `linkedin`, `twitter`, `address_line1`, `city`, `region`, `postal_code`, `country`.

2. **Mark on user edits** (`src/lib/contacts/crud.functions.ts`):
   - In `updateContact`, for every key present in the incoming patch with a non-empty value, union it into `manual_overrides`. Empty/null clears that key from the array (so a user blanking a field re-opens it to enrichment).
   - In `createContact`, seed `manual_overrides` with the non-empty fields the user typed.
   - In `renameCompanyBucket` / `setCompanyWebsite` / bulk edit paths, add `company` / `website` similarly.
   - Do this atomically in the same `update` call.

3. **Honor on enrichment** (`src/lib/contacts/enrich.functions.ts`, both `enrichContact` and the batch `rerunEnrichmentBatch` path around line 485–615):
   - Load `manual_overrides` with the contact.
   - Before assigning any field to `patch`, skip if the field is in `manual_overrides` — regardless of `force`.
   - For `name`, wrap the `pickBetterName` logic in the same guard: if `name` is locked, keep `contact.name` as-is.
   - `company` gets an extra guard: if `contact.company_id` is set (user explicitly linked a company via the combobox), treat `company` as locked even if not in `manual_overrides` — linking a company is an unambiguous user action.
   - `relationship_summary` and `enriched_at` are AI-owned and stay writeable.

4. **Client** — no UI change required. Enrichment silently respects the lock. (Optional: a small "edited by you" hint next to locked fields is out of scope for this fix.)

## Technical notes

- Field list to track lives in one constant `MANUAL_TRACKED_FIELDS` in `crud.functions.ts`, reused by enrichment via import so the two lists can't drift.
- Use `array_append` / `array_remove` in SQL via a small helper (compute the next array in JS from the loaded row + patch, then include it in the same `.update()` — avoids a race with the plaintext `.update` already running there).
- Encrypted fields (`phone`, `address_line1`, `address_line2`, `relationship_summary`) still route through the encrypted RPC; the lock check happens before we build the encrypted patch so locked encrypted fields are also skipped.
- No data backfill: existing contacts start with an empty `manual_overrides`, so the first future edit is what locks a field. That matches user intent ("if I edited it, it should stay") without guessing about historical rows.

## Out of scope

- Undoing past bad overwrites (revisions table already exists if you want to roll one back manually).
- A UI badge showing which fields are locked.
