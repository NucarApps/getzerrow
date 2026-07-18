
## What went wrong

When iOS sends an edited contact back over CardDAV, it can PUT a **partial vCard** that only contains the properties it cares about. Our `handlePut` in `src/lib/carddav/handlers.server.ts` treats every field returned by `parseVCard` as authoritative:

- `parseVCard` initializes every field to `null` and only fills in properties it saw. Any property iOS omits (ORG, TITLE, URL, ADR, X-SOCIALPROFILE, NOTE, TEL, CATEGORIES…) comes back `null` / `[]`.
- `handlePut` then does a full `UPDATE` with those nulls (company, title, website, city, region, postal_code, country, linkedin, twitter) — silently overwriting whatever the user had saved on the web.
- `setContactEncryptedFields` is called with `""` for missing `notes`, `address_line1/2`, and primary phone. The RPC docstring says empty string = "clear", so notes and address get erased.
- `contact_phones` is unconditionally deleted then re-inserted. If iOS omitted TEL lines, phones vanish.
- CATEGORIES reconciliation runs even when no CATEGORIES line was present, wiping group membership.

Then the next Google Contacts push cycle propagates the wiped values upstream because `updated_at` moved forward.

## Fix — merge semantics for CardDAV PUT

Update the parser and PUT handler so we only touch fields the client actually sent.

### 1. `src/lib/carddav/vcard.ts` — track which properties were present

- Add `presentFields: Set<string>` (or a typed flag object) to `ParsedVCard`.
- Populate it as each property is parsed: `FN/N`, `EMAIL`, `ORG`, `TITLE`, `ADR`, `URL`, `URL;LINKEDIN`, `URL;TWITTER`, `TEL`, `NOTE`, `CATEGORIES`, `X-SOCIALPROFILE`.
- Keep existing shape backward-compatible; only add the new field.
- Add/extend tests in `vcard.parse.test.ts` and `vcard.roundtrip.test.ts` to assert that a partial vCard produces a partial `presentFields` set.

### 2. `src/lib/carddav/handlers.server.ts` `handlePut` — patch, don't replace

- Build `plaintextPatch` dynamically: for each of `name, company, title, website, city, region, postal_code, country, linkedin, twitter`, include the key **only if** `presentFields.has(...)`. Never write `null` for a field the vCard didn't mention.
- For encrypted fields (`notes`, `address_line1/2`, primary phone), skip the call entirely when none of those properties were present; when some were present, send `""` only for the ones the client actually included and omit the rest (extend `setContactEncryptedFields` to treat `undefined` as "leave unchanged" if it doesn't already).
- Phones: only run the delete + re-insert when `presentFields.has("TEL")`. Otherwise leave `contact_phones` untouched.
- Group membership (`reconcileContactCategories`): only run when `presentFields.has("CATEGORIES")`. iOS routinely omits it for single-field edits.
- Keep `updated_at = now()` only when at least one column actually changed (compute from the patch) so a no-op PUT doesn't churn the Google push loop.

### 3. Safety net — snapshot before overwrite

- Add a lightweight `contact_revisions` table (`id, contact_id, user_id, snapshot jsonb, source text, created_at`) with RLS scoped to `auth.uid()` and standard GRANTs.
- In `handlePut`, before the update, insert a snapshot of the existing contact + phones + group memberships when we're about to change anything (source=`carddav`). Cap at ~20 rows per contact via a trim.
- Expose a minimal server fn `restoreContactRevision(revisionId)` and a "Restore previous version" action in `ContactDetailView.tsx` so a bad iOS sync is one click to undo.

### 4. Regression tests

- Extend `src/lib/carddav/sync.test.ts` with a "partial PUT preserves untouched fields" case: seed a contact with company/title/notes/phones/groups, PUT a vCard containing only `FN` + `EMAIL`, assert every other field survives.
- Add a case where iOS PUTs a vCard with an empty `NOTE:` line — that should clear notes (property present, value empty), distinguishing it from the "not sent" case.

## Technical notes

- No schema change to `contacts`; only the new `contact_revisions` table.
- No change to `pushToGoogle` — once local data stops being wiped, upstream stays correct.
- `parseVCard`'s public shape gains one optional field, so `handleGroupPut` and callers keep working.
- Bump the address-book CTag after deploying so iOS refetches and any locally-cached bad state on the device gets corrected on next sync.

## Out of scope

- Changing Google Contacts pull/push semantics.
- CardDAV group PUT path (already replaces membership from an explicit MEMBER list, which is correct for Apple group vCards).
