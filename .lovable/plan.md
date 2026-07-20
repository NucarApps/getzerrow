## Problem

Roberta Cote's primary phone is stored as `800-225-1865;7160` (main + extension separated by `;`). Saving the contact runs the whole phones array through `phoneEntrySchema`, whose regex rejects the semicolon:

```
/^[+\d\s().,#x/A-Za-z-]{3,60}$/
```

So any save (even to an unrelated field like Notes) fails with "Invalid phone format" on `phones.0.number`. Same regex lives in the mobile route.

## Fix

Widen the allowed phone character set to include the common extension separators used by iOS/Google Contacts and vCard sources — `;`, `*`, and `:` — while keeping the length + shape guard.

New regex:
```
/^[+\d\s().,#*;:x/A-Za-z-]{3,60}$/
```

## Files to change

- `src/lib/contacts-helpers.server.ts` — update `PHONE_NUMBER_RE`.
- `src/routes/api/mobile/contacts.ts` — update the mirrored `PHONE_NUMBER_RE` so the mobile create path stays in sync.

No data migration needed — existing rows already contain `;`, they just couldn't round-trip through validation.

## Verification

- Re-open Roberta Cote, edit Notes, save → succeeds.
- Add a phone like `+1 555-123-4567;123` in the editor → saves.
- Existing pure-digit / formatted numbers still validate.
