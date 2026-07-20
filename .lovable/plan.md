
## What's actually happening (verified in the DB)

- 18 contacts have a stored photo. All are linked to Google.
- `google_contact_links.photo_etag` is NULL on ALL 455 linked contacts and `photo_push_attempts = 0` on all of them → the photo-upload branch in the Google push loop has **never fired** for any of them. That's why nothing shows up in Google Contacts.
- 4 contacts are stamped `avatar_source = "user_upload"` (photos added on iPhone or in the web app). Those rows are surviving in the DB, so "iOS resets the photo" is happening on the **iPhone side** — iOS is discarding the picture it just saved on the next sync, not us wiping the row.

## Root causes

1. **Photo push starvation.** The push loop scans contacts oldest-updated first and caps at 200/run. Every linked contact is currently marked body-dirty (`last_synced_at = 1970`), so the 18 recent avatar contacts are always at the back of the queue and haven't been reached yet. Even once reached, the loop only tries a photo when `avatar_url !== photo_etag` — that condition is right, but there's no dedicated "photo-dirty first" pass.
2. **`photo_push_attempts` is never reset.** When a new photo arrives from iPhone/web/logo swap, we mark `last_synced_at = 1970` (body dirty) but leave `photo_push_attempts` alone. Any contact whose earlier attempts hit the cap of 5 becomes permanently stuck; the current 0-value contacts will hit this the first time Google returns a transient error.
3. **`photo_etag` semantics collide.** Push writes the local Zerrow URL into `photo_etag`; pull writes Google's signed URL into the same column. They compare unequal on the next tick, so the two loops keep re-shipping the same picture back and forth. It also masks "already pushed" state — we can't tell from the column whether Google actually has our latest bytes.
4. **iOS side revert after PUT.** After a photo PUT we do two post-hooks (`reconcileAutoParentsForContacts`, `applyRulesForContact`) that bump `contacts.updated_at` AFTER we've already computed the ETag we returned to iPhone. iPhone's next sync-collection sees the contact as changed under a different ETag, refetches, and — because the returned ETag it just committed no longer matches — some iOS versions treat the local edit as superseded and quietly drop unsent local state (including the photo it just uploaded, on the next round trip if anything else touches the vCard). It's also possible the recomputed vCard body differs slightly (order of TEL/EMAIL after reconcile), causing iOS to swap to the server copy.

## Fix plan

### 1. Make photo push a first-class queue (Google push)

In `src/lib/google-contacts/push.server.ts`:
- Split the dirty scan into two passes: **photo-dirty first**, then body-dirty, both capped by `MAX_CONTACTS_PER_RUN`. A contact is photo-dirty when `avatar_url IS NOT NULL AND (photo_etag IS NULL OR photo_etag != <stable id>) AND photo_push_attempts < MAX`.
- When only the photo needs pushing, skip the body update entirely (don't burn a People API write for no reason).
- After a successful `updateContactPhoto`, store a **stable identifier** in `photo_etag` — the SHA-256 of the bytes we uploaded — not the URL. Pull path stops writing to `photo_etag`; it can use a separate column if it needs to remember Google's URL (add `google_photo_url` on `google_contact_links`).

### 2. Reset the photo-retry counter on every new local photo

Add a `markGooglePhotoDirty(userId, contactId)` helper in `src/lib/google-contacts/mark-dirty.server.ts` that clears `photo_etag` **and** resets `photo_push_attempts = 0`. Call it from:
- `src/lib/contacts/photos.functions.ts` (uploadContactPhoto, removeContactPhoto)
- `src/lib/carddav/handlers.server.ts` PUT branch, right after `saveContactPhoto` succeeds
- `src/lib/companies/company-photo.functions.ts` (custom company logo upload/remove — cascades to members)
- `src/lib/company-logo.functions.ts` (brand-logo choice change)
- `src/lib/contacts/crud.functions.ts` self-heal path when it clears the avatar (so Google gets the deletion too)

Also do a one-shot cleanup in the same migration/script:
```sql
UPDATE google_contact_links SET photo_push_attempts = 0, photo_etag = NULL
WHERE contact_id IN (SELECT id FROM contacts WHERE avatar_url IS NOT NULL);
```
so the 18 already-stuck contacts push on the next run.

### 3. Stop the iOS post-PUT ETag drift

In `src/lib/carddav/handlers.server.ts` PUT handler:
- Move `reconcileAutoParentsForContacts` and `applyRulesForContact` to run **before** the final `SELECT updated_at` / ETag computation, OR
- Skip re-reading `updated_at` and freeze the ETag to the timestamp captured immediately after the primary UPDATE, then explicitly `UPDATE contacts SET updated_at = <that timestamp>` at the very end so the ETag we returned matches the row iPhone will see on the next GET.
- Add a regression test in `src/lib/carddav/` that asserts: `PUT → returned ETag === ETag of the very next GET` when the PUT carried a PHOTO.

### 4. Verify

- `supabase--read_query` after one push cycle: `photo_etag IS NOT NULL` for the 18 avatar contacts.
- Open a contact on iPhone, change the photo, wait for a sync tick, confirm the photo persists across a follow-up iPhone sync (no revert), and that it appears in Google Contacts within one push cycle.
- Add unit tests: (a) `filterPhotoDirtyForPush` prioritization, (b) `markGooglePhotoDirty` clears attempts, (c) CardDAV PUT ETag stability regression.

## Files touched

- `src/lib/google-contacts/push.server.ts` — two-pass dirty scan, SHA-based `photo_etag`
- `src/lib/google-contacts/pull.server.ts` — stop writing `photo_etag`; use new `google_photo_url` column
- `src/lib/google-contacts/mark-dirty.server.ts` — add `markGooglePhotoDirty`
- `src/lib/google-contacts/dirty.ts` + tests — photo-dirty helper
- `src/lib/carddav/handlers.server.ts` — ETag stability + call new dirty helper
- `src/lib/contacts/photos.functions.ts`, `src/lib/companies/company-photo.functions.ts`, `src/lib/company-logo.functions.ts`, `src/lib/contacts/crud.functions.ts` — call new dirty helper
- Migration: add `google_contact_links.google_photo_url` (nullable text), and the one-shot reset above

No UI changes required.
