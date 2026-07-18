## Problem

Opening a contact hangs on "Loading…" for any contact that has both a personal avatar and a linked company. `getContact` calls `buildKnownCompanyLogoShaSet(userId)` to detect an iOS "photo echo" (avatar bytes that are really a company logo). That helper walks every `company_domains` row for the user and fetches each domain's logo bytes sequentially from external providers to hash them. The current user has 107 company domains, so the first cold call blows the Cloudflare Worker subrequest / wall-clock budget and never returns.

## Fix

Remove the whole-set scan from the `getContact` hot path. It only ever needs to decide "is this specific avatar a snapshot of this contact's company logo?" — a scoped check, not a global one.

### 1. Narrow the echo check in `getContact` (src/lib/contacts/crud.functions.ts)

Replace the `avatarIsCompanyLogoSnapshot` block so it does at most 1 extra fetch:

- Keep the fast path: if `contacts.company_logo_photo_sha` equals the SHA of the stored avatar, flag it as a snapshot. No network.
- Fallback: fetch the current company logo bytes for **only** this contact's resolved `companyDomain` via `fetchChosenCompanyLogoBytes(userId, companyDomain)` and compare that one SHA.
- Delete the `buildKnownCompanyLogoShaSet` import/call from this file.

### 2. Keep `buildKnownCompanyLogoShaSet` but make it safe

`known-logos.server.ts` is still used by the CardDAV `PUT` guard and the cleanup batch. Make it non-fatal for large tenants:

- Cap concurrent logo fetches (e.g. `Promise.all` batches of 6) and wrap each fetch in a short `AbortController` timeout (~2s).
- Cap the total number of domains scanned per call (e.g. 60) — prefer domains that appear in `company_logo_choices` first, then most-recently-touched `company_domains`.
- Leave the 5-min TTL cache in place.

### 3. Verify

- Read `getContact` after the edit to confirm no reference to `buildKnownCompanyLogoShaSet` remains.
- Manually open a contact that has an avatar + company link on preview and confirm it renders in < 1s.
- Confirm the CardDAV echo test suite (`src/lib/carddav/photo-echo.test.ts`) still passes.

## Out of scope

No schema changes, no UI changes, no changes to the logo-resolution order or manual-override behavior. Only the echo-detection path is touched.
