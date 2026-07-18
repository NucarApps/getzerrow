## Real root cause (now confirmed)

Two independent bugs in the CardDAV write path combine to produce what you saw.

**Bug 1 — `itemN.` grouped properties are dropped by the parser.**
`src/lib/carddav/vcard.ts` `parseLine` takes the property name literally, so iOS lines like `item1.EMAIL;type=INTERNET;type=pref:you@example.com` come out with `name = "ITEM1.EMAIL"`. The switch in `parseVCard` only matches bare `EMAIL`, so `parsed.email` stays `null` and `presentFields` never learns EMAIL was there. iOS uses this grouped form whenever a field has an associated `X-ABLabel` (custom labels) and often for the first EMAIL/URL/ADR/TEL on a freshly created contact. Same silent-drop happens to `URL`, `ADR`, `TEL`, `X-SOCIALPROFILE`, and `NOTE` when iOS groups them.

**Bug 2 — placeholder email fallback.**
`src/lib/carddav/handlers.server.ts` line ~930 still synthesizes `carddav+<uuid>@local.zerrow` when `parsed.email` is null. That constraint is gone (`contacts.email` is nullable now), but the fallback wasn't removed. Combined with Bug 1, iOS sends your real email in a grouped property → parser misses it → placeholder is written → next sync serves the placeholder back to iOS as the "real" email.

The "edit blows out my email" symptom is the same mechanism: iOS re-PUTs the contact with the grouped EMAIL line, parser drops it, `presentFields` has no EMAIL, and — because `email` in the plaintext patch is currently written unconditionally — we overwrite with `existing.email` (the placeholder).

## Fix

1. **Strip the `itemN.` group prefix in the parser.** In `parseLine` (`src/lib/carddav/vcard.ts`), if the first segment matches `/^item\d+\./i`, drop that prefix before uppercasing. Optionally keep the group id in a `group` field for future use (not needed today). This restores parsing for EMAIL/TEL/URL/ADR/NOTE/X-SOCIALPROFILE lines from iOS.
2. **Remove the placeholder email fallback.** In `handlePut` (`src/lib/carddav/handlers.server.ts`):
   - Drop the `carddav+${contactId}@local.zerrow` fallback.
   - Gate `email` on `presentFields.has("EMAIL")` like every other field, so a partial PUT can't clobber an existing email.
   - For a brand-new contact with no EMAIL in the vCard, insert `email: null`.
3. **Stop echoing legacy placeholders back to iOS.** In `contactToVCard` (`src/lib/carddav/vcard.ts` line ~107), skip the `EMAIL:` line when the stored value matches `/^carddav\+[0-9a-f-]+@local\.zerrow$/i`.
4. **One-time cleanup migration.** Null out any existing placeholder emails and bump the CardDAV resync nonce so iPhones pull fresh vCards on next sync:
   - `UPDATE public.contacts SET email = NULL WHERE email ~* '^carddav\+[0-9a-f-]+@local\.zerrow$'`
   - `UPDATE public.carddav_settings SET resync_nonce = gen_random_uuid()`
5. **Regression tests.**
   - `src/lib/carddav/vcard.parse.test.ts` — add cases for `item1.EMAIL`, `item2.TEL`, `item1.URL`, `item1.ADR` producing the same parse output as their ungrouped forms, and asserting `presentFields` contains the base property.
   - `src/lib/carddav/vcard.roundtrip.test.ts` — legacy placeholder email is not emitted.
   - Small handler-level test (new file, or extend `sync.test.ts`) covering the "PUT without EMAIL preserves existing email; PUT with EMAIL writes it; new contact without EMAIL stores null" matrix.

## Files touched

- `src/lib/carddav/vcard.ts` — strip `itemN.` prefix in `parseLine`; skip placeholder emails in `contactToVCard`.
- `src/lib/carddav/handlers.server.ts` — gate `email` on `presentFields`; remove placeholder fallback.
- New Supabase migration — null out placeholder emails + bump `carddav_settings.resync_nonce`.
- `src/lib/carddav/vcard.parse.test.ts`, `src/lib/carddav/vcard.roundtrip.test.ts` (+ handler test) — regression coverage.

No UI or auth changes. After deploy, iPhone will pull fresh vCards (immediately if you pull-to-refresh in Contacts, else within ~15 min) and the placeholder emails disappear. Adding a new contact on iOS with a real email — including with custom labels — will save that email, and subsequent iOS edits won't overwrite it.