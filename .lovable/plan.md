## Problem

Bryan Barks (and any contact with a stale synced avatar + linked company) briefly shows the correct company logo, then flickers to an old picture. Same root cause as Aditya, but the previous fix only covered part of it.

Today's echo detection in `getContact` (src/lib/contacts/crud.functions.ts:162-190) considers `avatar_url` a "company logo snapshot" only when its SHA equals either:

1. `contacts.company_logo_photo_sha` — populated **only** when a CardDAV `GET` served a company-logo fallback (see `loadContactPhotoOrLogo`, handlers.server.ts:166-192).
2. The bytes of the **currently chosen** logo (single provider) for the contact's resolved company domain.

Bryan's avatar SHA matches neither because:
- His snapshot was captured before `company_logo_photo_sha` tracking existed, or came in through a different sync path that never wrote it.
- The user has since changed the logo pick (or a different provider is currently returning bytes), so the "current pick" bytes differ from the frozen old snapshot.

Result: the client loads the signed `avatar_url` on top of the company-logo fallback, causing the flicker back to the wrong image. Any contact whose stale avatar came from an older logo choice/provider is affected.

## Fix

Broaden the echo detection so any historically-valid company logo counts, and back-fill the fingerprint so it heals itself on first view.

### 1. Expand the scoped echo check in `getContact` (src/lib/contacts/crud.functions.ts)

When `contacts.company_logo_photo_sha` doesn't match and the "current pick" comparison fails:

- Look up every `company_domains` row for the contact's linked `company_id` (bounded — one company).
- For each domain, fetch every provider variant via `providersFor(domain)` in `logo-photo.server.ts` (7 URLs). Bound the total at ~20 fetches (one company × ~2 domains × 7 providers), all cached in the existing in-memory logo cache. Compare each SHA against the avatar SHA.
- On a match: set `avatarIsCompanyLogoSnapshot = true` AND write the matching SHA to `contacts.company_logo_photo_sha` so subsequent loads skip the scan.

Keep the existing 2-step fast paths (stored SHA, current pick) as the first checks so most calls stay cheap.

### 2. Self-heal by clearing the stale avatar

When the broadened check flags a snapshot, also null out `contacts.avatar_url` and delete the storage object (reuse the existing `deleteContactPhoto` helper in `photos.server.ts`). This is the same remediation the manual "Reset to company logo" button does — do it automatically so the flicker never recurs for that contact.

Guard with the `company_id` linkage check so we never clear a genuinely user-uploaded photo.

### 3. Persist `company_logo_photo_sha` on every logo-serving path

Currently only the CardDAV `GET` fallback (handlers.server.ts:178-190) writes the sha. Add the same write to:

- Google Contacts push (`src/lib/google-contacts/push.server.ts`) whenever the pushed photo bytes come from `fetchChosenCompanyLogoBytes`.
- The company-logo cleanup batch (`src/lib/contacts/company-logo-cleanup.functions.ts`) so backfills tag the current choice.

This means future logo swaps by the user only need to update `company_logo_choices`; the echo path already knows the last frozen SHA per contact.

### 4. Verify

- Add a focused test in `src/lib/contacts/logo-photo.test.ts` (or a sibling) that constructs a contact with an `avatar_url` whose bytes match a **non-current** provider variant and asserts `getContact` returns `avatarIsCompanyLogoSnapshot: true` and clears the avatar.
- Re-run `src/lib/carddav/photo-echo.test.ts` — behavior there should stay identical (that guard still uses `buildKnownCompanyLogoShaSet`).
- Manually open Bryan Barks on preview and confirm the flicker is gone; open a contact with a real user-uploaded photo and confirm the photo still shows.

## Out of scope

- No schema changes (all needed columns already exist).
- No changes to the `ContactPhotoUploader` client — it already respects `avatarIsCompanyLogoSnapshot`.
- No changes to `buildKnownCompanyLogoShaSet` or the CardDAV `PUT` guard beyond the SHA persistence in step 3.
