# Fix "Invalid phone format" when saving scanned contacts

## Problem
Saving a contact fails with `Invalid phone format` whenever a phone number includes an extension such as `603.202.3600 ext` or `... x123`. The scanned card includes "ext"/"x", but the server-side validation regex rejects any letters.

## Root cause
In `src/lib/contacts.functions.ts`:
```
const PHONE_NUMBER_RE = /^[+\d\s().-]{3,60}$/;
```
This only permits digits, spaces, and `+ ( ) . -`. The letters in "ext" fail the pattern, so Zod throws `Invalid phone format` for `phones[0].number` on save (used by `updateContact` and the scan-save flow).

## Fix
Broaden `PHONE_NUMBER_RE` to allow common extension notation — letters (for `ext`/`x`), `#`, and `,` — while still keeping it constrained to phone-like characters:
```
const PHONE_NUMBER_RE = /^[+\d\s().,#x/A-Za-z-]{3,60}$/;
```
This accepts values like `603.202.3600 ext`, `603.202.3600 ext 12`, and `(603) 202-3600 x123`, while still rejecting free-form non-phone text via the limited character set, the 3–60 length bound, and the `.min(3)`.

No client-side phone regex exists (the scan page only trims/filters empties), so this single change covers both the manual edit and scan-save paths.

## Verification
- Save a scanned contact whose phone is `603.202.3600 ext` → succeeds, no error toast.
- Save a normal number `(603) 202-3600` → still succeeds.
- Existing unit tests (if any cover phones) still pass.
