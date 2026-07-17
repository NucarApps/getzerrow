## Goal

Let iPhone edits (create/update/delete contact, add/change/remove phone, address, notes, etc.) flow back into Zerrow's `contacts` + `contact_phones` tables, while keeping the existing read path (iOS → Zerrow) working.

## What changes

### 1. CardDAV HTTP surface (`src/routes/api/public/carddav/$.ts`)
Add three verbs iOS uses for writes:
- `PUT /carddav/<email>/contacts/<uuid>.vcf` — create or replace a contact
- `DELETE /carddav/<email>/contacts/<uuid>.vcf` — delete a contact
- Advertise them in `Allow` + `DAV` headers and in `OPTIONS`

Honor conditional headers so we don't clobber concurrent edits:
- `If-Match: <etag>` on PUT/DELETE → 412 if the stored ETag differs
- `If-None-Match: *` on PUT → 412 if the UID already exists (iOS create semantics)

### 2. vCard parser (`src/lib/carddav/vcard.ts`)
Add `parseVCard(text)` alongside the existing `contactToVCard`:
- Unfold CRLF+space continuations, split on CRLF/LF
- Parse `FN`, `N`, `ORG`, `TITLE`, `EMAIL`, `TEL` (with `TYPE` params), `ADR`, `URL`, `NOTE`, `UID`, `REV`
- Unescape `\,` `\;` `\\` `\n`
- Return a normalized shape: `{ uid, name, email, company, title, phones: [{label,number,is_primary}], address, website, linkedin, twitter, notes }`
- Map `TYPE=CELL` → "Mobile", `WORK` → "Work", `HOME` → "Home"; first `TEL` with `pref` becomes `is_primary`

### 3. Handlers (`src/lib/carddav/handlers.server.ts`)
New `handlePut` and `handleDelete`:

- `handlePut`:
  1. Extract UUID from path; reject non-UUID with 400
  2. Parse the vCard body; reject unparseable with 400
  3. Look up existing `contacts` row scoped to `userId`
  4. Enforce `If-Match` / `If-None-Match` against `contactETag`
  5. Upsert:
     - Plaintext columns (`name`, `email`, `company`, `title`, `website`, `city`, `region`, `postal_code`, `country`, `linkedin`, `twitter`) via `supabaseAdmin` on `contacts`
     - Encrypted columns (`notes`, `address_line1`, `address_line2`, `phone`) via existing `set_contact_encrypted_fields` RPC with `EMAIL_ENC_KEY`
     - Replace `contact_phones` rows for that contact with the parsed list (delete + insert in a single transaction-ish batch; positions from array index)
     - Bump `updated_at` so CTag/ETag move
  6. Return `201 Created` (new) or `204 No Content` (update) with fresh `ETag`

- `handleDelete`:
  1. Enforce `If-Match`
  2. Cascade `contact_phones` first, then `contacts` (RLS-scoped via `supabaseAdmin` with `user_id` filter)
  3. Return `204`

- Update `computeBookCTag` — already based on `updated_at` + count, so it moves on writes automatically. No change needed.

### 4. Deletion semantics — decision to confirm
Two options. Plan defaults to A; flag it in the UI so the user knows.

- **A. Hard delete (default).** iOS "Delete Contact" removes the row from Zerrow, including any enrichment/relationship-summary history. Simple, matches user expectation.
- **B. Soft delete.** Add `deleted_at` to `contacts`, hide from list/search RPCs. Preserves history but bigger refactor (every contact query filters it out).

I'll implement A now and note it in the Settings page copy. Switching to B later is a migration + query filter.

### 5. Field coverage — what iOS can and cannot change
Round-trippable (parsed on write, emitted on read): name, email, company, title, phones, address, website, linkedin, twitter, notes.

Not touched by iOS writes (preserved as-is): `avatar_url`, `card_image_url`, `relationship_summary_enc` (AI-generated), `source`, `enriched_at`, `summary_generated_at`, group memberships, company aliases. If iOS drops a field we don't parse, we keep the stored value.

### 6. Settings page copy (`src/routes/_authenticated/settings.carddav.tsx`)
Change the description from "Read-only — changes on your phone don't push back" to a two-way explanation, and add a short note that deletes on iPhone remove the contact from Zerrow.

### 7. Tests
- Unit tests for `parseVCard` (unfold, escape, TYPE parsing, missing fields)
- Unit test that `contactToVCard(parseVCard(x))` round-trips core fields
- Integration test hitting the splat route: PUT new UID → GET returns it → PUT with wrong If-Match → 412 → DELETE → GET → 404

## Risks / tradeoffs

- **iOS may PUT with a UID it invented** (rare for edits, common for adds). We accept any UUID-shaped UID; non-UUID UIDs get rejected with 400. Real Contacts app uses UUIDs.
- **Encrypted phone field collision.** We already emit `TEL` from both `contact_phones` and the legacy encrypted `contact.phone`. On write we always populate `contact_phones` and mirror the primary into the encrypted `phone` field so downstream code keeps working.
- **No CTag change detection on iOS side of the equation.** Two-way still relies on iOS's PROPFIND polling; we already return the correct CTag/ETag pair, so nothing extra needed.
- **RLS.** `carddav_tokens` gates auth; writes use `supabaseAdmin` scoped by `user_id` from the verified token (never trust the vCard's UID for ownership).

## Files touched

- `src/lib/carddav/vcard.ts` — add `parseVCard`
- `src/lib/carddav/handlers.server.ts` — add `handlePut`, `handleDelete`, tighten `Allow`
- `src/routes/api/public/carddav/$.ts` — route PUT/DELETE
- `src/routes/_authenticated/settings.carddav.tsx` — copy update
- New: `src/lib/carddav/vcard.parse.test.ts`, `tests/carddav-write.integration.test.ts`

No DB migration required (hard delete path).
