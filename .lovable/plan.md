# Sync contact photos across iPhone, Zerrow, and Google

Right now the vCard builder and parser skip `PHOTO` entirely, and the Google People sync ignores photos too. So if you set a picture on your iPhone contact, iOS uploads it in the vCard `PUT`, we discard it, and on the next refresh iOS sees no photo and clears its own. This plan makes photos a first-class synced field the same way emails and phones are.

## What you'll see
- Add or change a contact photo on iPhone → shows up on Zerrow within seconds.
- Add or change a photo in Zerrow (existing avatar picker) → shows up on iPhone on next sync and pushes to Google Contacts.
- Photos survive partial iOS `PUT`s the same way emails do — a vCard without `PHOTO` won't wipe an existing picture.

## Scope
- iPhone ⇄ Zerrow via CardDAV (embedded base64 PHOTO in vCard).
- Zerrow ⇄ Google Contacts via People API (photo upload/download).
- Existing `contacts.avatar_url` column stays the single source of truth; new photos are stored in a private `contact-photos` Storage bucket and `avatar_url` points at a signed URL.

## Technical details

### 1. Storage
- New private bucket `contact-photos`, path `{user_id}/{contact_id}.jpg`.
- RLS: owner-only read/write via storage.objects policies keyed on the folder prefix.
- Helper `setContactPhoto(contactId, bytes, mime)` in `src/lib/contacts/photos.server.ts` — writes bytes, updates `contacts.avatar_url`, bumps `updated_at`, records a `contact_revisions` entry (so the existing 20-deep undo covers photo changes too).

### 2. CardDAV (iPhone ⇄ Zerrow)
- `src/lib/carddav/vcard.ts`
  - Parser: recognize `PHOTO;ENCODING=b;TYPE=JPEG:…` and vCard 4-style `PHOTO:data:image/jpeg;base64,…`; return `{ mime, bytes }`. Track `PHOTO` in `presentFields` only when a real value was present (empty PHOTO line is ignored, same rule as EMAIL).
  - Builder: when `avatar_url` is set, fetch the bytes and inline as `PHOTO;ENCODING=b;TYPE=JPEG:<base64>` with the 75-char line folding we already use.
- `src/lib/carddav/merge.ts` + `handlers.server.ts`
  - Treat photo like emails: only overwrite when the incoming vCard actually carried a PHOTO value; blank/missing PHOTO leaves the server photo untouched.
  - On PUT with a photo, call `setContactPhoto` and set `google_contact_links.last_synced_at = 1970-01-01` so the change gets pushed to Google on the next tick.
- Bump `carddav_settings.resync_nonce` in the migration so iPhones re-pull and pick up embedded photos.

### 3. Google Contacts (Zerrow ⇄ Google)
- `src/lib/google-contacts/people-client.server.ts`: add `getContactPhoto(resourceName)` (uses `photos.default` URL from person payload) and `updateContactPhoto(resourceName, bytes)` (People `people:updateContactPhoto`).
- `src/lib/google-contacts/mapper.ts` + `pull.server.ts`: when a person has a non-default photo and Zerrow's copy is missing or hash-differs, download and store via `setContactPhoto`.
- `src/lib/google-contacts/push.server.ts`: when a dirty contact has a photo we haven't pushed (track via a new `contact_emails`-style hash column `google_contact_links.photo_etag`), call `updateContactPhoto`.
- Conflict guard already added for emails is reused: pull first if Google's photo is newer than our `last_synced_at`.

### 4. UI
- `ContactDetailView.tsx`: the avatar area already displays `avatar_url`; add an "Upload photo" / "Remove photo" control wired to `setContactPhoto` and a delete server fn. No new component needed beyond a small `PhotoEditor.tsx`.

### 5. Migration
```sql
-- storage bucket via supabase--storage_create_bucket (private)
alter table public.google_contact_links add column if not exists photo_etag text;
update public.carddav_settings set resync_nonce = gen_random_uuid();
```
Storage RLS: standard "owner folder" pattern on `storage.objects` for `contact-photos`.

### 6. Tests
- Extend `src/lib/carddav/sync.regression.test.ts`:
  - iOS PUT with new PHOTO stores bytes and sets avatar_url.
  - iOS PUT without PHOTO leaves an existing photo alone (mirrors the empty-EMAIL regression).
  - iOS PUT with explicitly cleared PHOTO (empty value) is ignored (photos never get nulled by a partial PUT).
- New `src/lib/carddav/vcard.photo.test.ts` for parse/build round-trip of base64 PHOTO with line folding.

## Out of scope
- HEIC → JPEG conversion (iOS already sends JPEG for contact photos).
- Photo cropping UI beyond the existing avatar picker.
- CalDAV / meeting attendee photos.
