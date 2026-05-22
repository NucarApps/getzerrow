# Normalize contact names + sort by first name

## Problem
Names on contacts come from many sources (email `from_name`, AI signature extraction, manual entry) in inconsistent formats: `"Smith, John"`, `"JOHN SMITH"`, `"john smith"`, `"\"John Smith\""`. The list is currently sorted by raw `name` in Postgres, so `"Smith, John"` sorts under S instead of J.

## Change

### 1. Add `normalizeName()` helper in `src/lib/contacts.functions.ts`
A single pure function used everywhere we write a contact name:
- Trim, strip surrounding quotes and angle brackets.
- Collapse whitespace.
- Drop common email-noise suffixes in parens (e.g. `"John Smith (via Acme)"` → `"John Smith"`).
- If the string matches `Last, First [Middle]` (one comma, no parens), reorder to `First [Middle] Last`.
- If the string is ALL CAPS or all lowercase and has no diacritics-only tokens, title-case it.
- Return `null` for empty/garbage.

Plus a tiny `firstNameKey(name, email)` helper used for sorting: returns the first token of the normalized name, lowercased; falls back to the email local-part.

### 2. Apply normalization at every write site (same file)
- `enrichContact` — wrap the `name` field in the `patch` through `normalizeName`.
- `scanContactFromEmail` — wrap `email.from_name` and the AI-extracted `name`.
- `createContact` and `updateContact` — wrap incoming `name` before insert/update.
No DB migration; we only normalize new writes. Existing rows get cleaned up the next time they're enriched or edited (acceptable — re-enrich also rewrites name when `force: true`).

### 3. Sort by first name in `listContacts`
Sorting "first token of a normalized string" isn't clean in Postgres, so:
- Keep the query as-is (no `.order` on name) and sort the returned array in JS by `firstNameKey(c.name, c.email)` ascending, case-insensitive, with empty keys last.
- List is capped at 2000 rows, so JS sort is trivial.

### 4. (Optional, included) One-time normalization of existing rows
On the next `Re-enrich` click for any contact, the name is already overwritten. To avoid waiting for users to click each one, also normalize the **existing** `contact.name` at the top of `enrichContact` (before any AI work) and write it back if it changed — so opening a contact's page once fixes its display.

## Out of scope
- No UI changes (list rendering, search, group filter all untouched).
- No DB schema change, no migration, no bulk SQL rewrite of historical names.
- We are not splitting `name` into separate `first_name`/`last_name` columns — keeping a single normalized `"First Last"` string.
