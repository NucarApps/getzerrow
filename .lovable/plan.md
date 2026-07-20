## What I found

Roberta Cote (contact `875e7215…`, linked to Google as `people/c1814011048600397749`) currently has:

- `avatar_url = NULL` on the contact row
- `card_image_url = NULL`
- her company (Fred C. Church, Inc.) also has `logo_url = NULL`

So when you press **Sync to Google now**, `pushContactPhotoToGoogleNow` marks the link photo-dirty and runs the sync, but `pushContacts` skips the photo upload because `avatarUrl` is null — nothing is ever POSTed to People API's `updateContactPhoto`. That matches your symptom (no error, no update in Google) and is why nothing changes for her specifically.

Two things need to happen:

### 1. Root-cause the missing avatar_url

I need to know where you set the picture, because the fix differs:

- **Uploaded in Zerrow (drag-drop on the contact avatar):** the uploader is failing silently before it writes `avatar_url`. I'll add error surfacing + verify the upload path in `ContactPhotoUploader`.
- **Set on iPhone via CardDAV:** the PHOTO from the last PUT was probably discarded by the company-logo echo guard (`known-logos.server.ts`) or by `avatar_source` tagging. I'll inspect the last CardDAV PUT for her card and adjust the guard so a real user photo isn't dropped.
- **Meant to inherit the company logo:** Fred C. Church has no `logo_url` — the plan is to set a company logo, not sync per-contact.

### 2. Make "Sync to Google now" honest

Regardless of #1, the button today silently succeeds when there's nothing to push. I'll:

- Have `pushContactPhotoToGoogleNow` pre-check `avatar_url` (and fall back to the resolved company logo when appropriate) and return `no_photo_on_contact` when neither exists, so the toast tells you clearly instead of showing "synced".
- Add a `logInfo("google_contacts.push.photo_skipped_no_avatar", …)` inside `pushContacts` so future silent skips show up in logs.

### Technical notes

- Files touched: `src/lib/google-contacts/push-photo-now.functions.ts`, `src/lib/google-contacts/push.server.ts`, and (depending on #1 answer) either `src/components/contacts/ContactPhotoUploader.tsx` or `src/lib/carddav/handlers.server.ts` + `known-logos.server.ts`.
- No schema changes.
- Add a small unit test that `pushContactPhotoToGoogleNow` returns `no_photo_on_contact` when both contact and company photo are missing.

**Before I implement:** where did you set Roberta's picture — uploaded inside Zerrow, set on your iPhone Contacts app, or did you expect it to come from the company logo?