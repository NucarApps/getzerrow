## Goal

On a company's "Find people from email & calendar" list, when a candidate looks like a person you already have (same name, just a new email domain — e.g. the company rebranded), surface that match and let you enhance the existing contact instead of creating a duplicate.

## What changes

### 1. Server: match candidates against existing contacts

Extend `findCompanyPeopleByDomain` in `src/lib/companies/company-people.functions.ts` so each returned person can carry up to 3 `possibleMatches`.

For each candidate email at the company's domain:

- Derive the candidate's likely name (existing `nameFromLocalPart`, or the name we've seen in headers/calendar).
- Look up existing contacts by:
  - Exact normalized full-name match (reuse `normalizeNameLoose` from `name-match.ts`).
  - Same local part on a **different** domain (john@old.com ↔ john@new.com).
  - Loose first+last token match against `firstLastTokens`.
- Score each candidate (name-exact > local-part-exact > loose), keep top 3 with score ≥ threshold.
- For each match, also flag:
  - `sameCompanyId`: match is already linked to this company (strong "yes, enhance").
  - `differentDomain`: match's current email is on a domain other than any of this company's — this is the "company changed domain" signal.

Ambiguous top-2 candidates (score tie among multiple people) go through a single Lovable AI Gateway call using `google/gemini-3.1-flash-lite` with a strict `Output.object` schema returning `{ pick: contactId | null, confidence }` per candidate. AI is only invoked to break ties, not on every row, to keep this cheap. Guarded with `NoObjectGeneratedError` fallback per gateway rules.

### 2. Server: enhance existing contact

New server function `enhanceContactWithNewEmail` in `src/lib/companies/company-people.functions.ts`:

Input:
```
{ companyId, contactId, newEmail, mode: "replace_primary" | "add_secondary" }
```

Behavior (ownership-checked, uses `supabaseAdmin` after check):
- Verify contact and company both belong to `userId`.
- Insert/update `contact_emails`:
  - `add_secondary`: insert new email as non-primary (uniqueness handled like current select-then-insert path).
  - `replace_primary`: demote the current primary to secondary, insert new email as primary, and mirror onto `contacts.email`.
- Set `contacts.company_id = companyId` and add `"company"` to `manual_overrides` so enrichment doesn't undo it.
- Fire `reconcileAutoParentsForContacts` for that contact.
- Bump `carddav_settings.resync_nonce` so iPhone picks it up.
- Return `{ ok: true, contactId }`.

### 3. UI: show match + choices in CompanyPeopleFinder

In `src/routes/_authenticated/contacts.companies.$companyId.tsx`, for any row where `possibleMatches.length > 0`:

- Under the row, render a subtle banner: **"Looks like [Contact Name] — company domain change?"** (with each match's current email in muted text).
- Row-level actions become a small menu:
  - **Enhance existing → Replace email** (uses `replace_primary`)
  - **Enhance existing → Add as secondary email** (uses `add_secondary`)
  - **Add as new person** (current path — `addCompanyPeople`)
- When multiple matches, show a compact picker so the user chooses which existing contact.
- Bulk "Add selected" continues to work for candidates with no match; a candidate with an accepted enhancement is removed from the bulk-add set and processed via the new function instead.

Confirmation toast summarizes: "Updated Jane Doe with jane@new-domain.com" / "Added jane@new-domain.com as secondary to Jane Doe".

### 4. Cache invalidation

After enhance:
- Invalidate `["company-people", companyId]`, `["company", companyId]`, `["contact", contactId]`, `["contacts"]`, `["contact-duplicates"]`.

## Non-goals for this change

- No automatic (no-confirmation) enhancement — user always confirms per row.
- No changes to the `addCompanyPeople` path itself.
- No cross-company detection beyond what's needed to flag "different domain" — full cross-company merge already lives in the company merge tools.
- No changes to Google Contacts push here; the existing tombstone/sync loop handles the follow-up automatically once `contacts.email` and `contact_emails` change.

## Technical notes

- Reuse `normalizeNameLoose`, `firstLastTokens`, `emailLocalPart` from `src/lib/contacts/name-match.ts` — no new matching utilities.
- Keep the AI call gated behind a `TIE_ONLY` code path so most searches don't hit the gateway.
- Reuse the select-then-insert pattern already in `company-people.functions.ts` to avoid `ON CONFLICT` issues with case-insensitive emails.
- No new tables or migrations.
