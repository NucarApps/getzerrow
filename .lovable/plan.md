# Stop CardDAV company-logo fallback from becoming a real photo

## Root cause

`src/lib/carddav/handlers.server.ts` (~line 148–174) sends the chosen company logo as the vCard `PHOTO` when the contact has no personal `avatar_url` and `use_company_logo_fallback` is on. iOS treats that inlined photo as the contact's picture and echoes it back on the next PUT. The PUT branch at ~line 1153 sees `parsed.photo.bytes.length > 0`, calls `saveContactPhoto`, and permanently writes those company-logo bytes into `contacts.avatar_url` (verified for Erica Roy — her `avatar_url` points to a file in `contact-photos` even though she never had a personal photo). After that:

- The app UI (`ContactPhotoUploader`, list rows) prefers `avatar_url` over the live company logo, so changing the company logo has no visible effect on her.
- The stored file is a frozen snapshot of the *old* logo, which is exactly what the user is seeing.

## Change

Track the exact bytes we inline as a company-logo fallback, and refuse to promote a round-tripped copy into a real avatar. Then clean up already-affected contacts.

### 1. Record what we sent as a fallback

- Add a `company_logo_photo_sha` `text` column to `contacts` (nullable) via migration. GRANTs identical to existing contacts grants; no policy changes.
- In `handlers.server.ts` `getContactPhotoWithFallback` (~line 166), when we return company-logo bytes (i.e. `own` is null and we fell back), compute `sha256(bytes)` and upsert it into the contact row before returning. Cheap, one small update per fallback GET.

### 2. Ignore inbound PHOTOs that match the fallback we sent

- In the PUT PHOTO branch (~line 1153), before calling `saveContactPhoto`, compute `sha256(parsed.photo.bytes)`. If it equals the contact's `company_logo_photo_sha`, treat it as a no-op (log at info level, skip the save). Only genuinely new photos become the personal avatar.
- Belt-and-suspenders: also skip if the incoming bytes exactly match `loadContactPhotoBytes(current avatar_url)` — iOS sometimes re-uploads unchanged existing photos.

### 3. One-time cleanup for Erica and anyone else already tainted

- Add a small `createServerFn` `cleanupCompanyLogoPhotos` in `src/lib/contacts/photos.functions.ts` that, for the calling user:
  1. Loads every contact with `avatar_url IS NOT NULL AND company_id IS NOT NULL`.
  2. For each, fetches the currently chosen company logo bytes (`fetchChosenCompanyLogoBytes`) and compares sha256 to the stored avatar bytes.
  3. On match, calls `deleteContactPhoto` (already exists in `photos.server.ts`) so the row falls back to the live company logo.
- Surface it as a "Fix contacts showing an old company logo" button in Settings → iPhone contacts (same panel that hosts "Rerun for everyone" / "Force iPhone resync"). Chunk in the client the same way, with live progress.

### 4. Bump CardDAV resync nonce

- When cleanup clears any avatars, bump the user's `resync_nonce` (same helper the logo-choice flow uses) so iPhone re-pulls fresh vCards and picks up the current company logo.

## Out of scope

- No changes to the app UI's photo-priority order (personal photo still wins over company logo — that's still correct now that the personal photo will actually be personal).
- No changes to Google Contacts pull/push photo behavior.
- No schema change to `company_logo_choices` or company logo picker UI.

## Technical notes

- Files touched: `src/lib/carddav/handlers.server.ts`, `src/lib/contacts/photos.functions.ts`, `src/lib/contacts/photos.server.ts` (small hash helper), `src/routes/_authenticated/settings.carddav.tsx` (button + progress), new migration for `company_logo_photo_sha`.
- Use Web Crypto `crypto.subtle.digest("SHA-256", …)` for hashing — already available in the Workers runtime.
- Cleanup is idempotent and per-user; safe to re-run.
