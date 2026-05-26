## Goal
The address UI, DB columns, scan extraction, and `updateContact` already handle the 6 address fields (`address_line1`, `address_line2`, `city`, `region`, `postal_code`, `country`). What's still missing is the **email-signature enrichment** path — it doesn't extract or persist addresses, so contacts auto-enriched from past emails never get an address filled in.

## Changes (all in `src/lib/contacts.functions.ts`)

1. **Extend `EXTRACT_SCHEMA`** (line 46) with the 6 address fields as `z.string().nullable()`.

2. **`enrichContact`** (lines ~333–382):
   - Update the prompt's "Fields" list to include the 6 address fields, with an instruction to split a postal address found in a signature into the components and only return values clearly printed.
   - Extend the default `extracted` object and the `patch` type with the address fields.
   - Extend the field-merge loop so each address field is copied into `patch` when the AI returned a value and the contact has no value yet (or `force` is true) — same rule as `title`/`company`.

3. **`addContactFromEmail`** (lines ~778–821):
   - Same prompt update.
   - Same default/patch extension and same merge loop addition.

4. **`shareContactByEmail`** (line ~849): include the 6 address fields in the `select(...)` so the shared-contact email body can render the address. (Will need a matching tweak wherever the email body is composed — I'll check `composeContactEmail`/template in the same file and include the address block only when at least one line is present.)

## Out of scope
- No DB migration (columns exist).
- No UI changes (ContactDetailView and the scan review form already edit these fields).
- No change to the scanned-card extraction (already complete).

## Files
- edit: `src/lib/contacts.functions.ts`
