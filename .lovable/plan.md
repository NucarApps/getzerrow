# Contact photo fallback + backfill

Two related gaps:

1. **No fallback picture.** When a contact has no `avatar_url`, the app renders the orange initials tile and CardDAV emits no `PHOTO`, so iOS also has nothing. We should fall back to the company logo we already resolve for the contact.
2. **Chanell case: iOS has a photo, Zerrow doesn't.** Photo sync only fires when a picture is *changed after* the feature shipped. Contacts whose photo predates it never re-push from iOS and (if unlinked to Google) never get pulled. We need a way to backfill those.

## What to build

### A. Company-logo fallback (display + push)

- New helper `resolveContactPhoto(contact)` that returns, in order:
  1. `avatar_url` (real user photo) — unchanged.
  2. A *derived* company-logo photo — the same logo `CompanyLogo` shows in the UI, resolved from the contact's email domain / `company_logo_choices`.
  3. `null` → initials tile stays.
- Store the derived source as a **virtual** photo, not written back into `contacts.avatar_url`, so a real user photo added later always wins and clearing the company never leaves stale bytes. Track it via a new nullable `contacts.logo_photo_domain` + `logo_photo_etag` (etag = provider+domain hash) so we know when to re-push.
- **UI (`ContactPhotoUploader`, contact list avatars):** when `avatar_url` is null but `logo_photo_domain` is set, render `<CompanyLogo domain=... />` instead of initials. Uploader "Remove" only clears the real photo; the logo fallback then reappears automatically.
- **CardDAV push (`vcard.ts` / `handlers.server.ts` GET):** when no real photo, fetch the logo bytes server-side (reuse `/api/public/logo` guards for SSRF safety), inline as `PHOTO;ENCODING=b`. Cache bytes in the `contact-photos` bucket under a `logo/<domain>/<provider>.jpg` key so we don't re-fetch per contact.
- **Google push:** same fallback — upload the logo bytes via `updateContactPhoto` when no real photo exists. Guard with the etag so we don't re-upload every sync.
- **Settings toggle** on `settings.carddav.tsx`: "Use company logo when a contact has no photo" (default on). Toggling off bumps `resync_nonce` and strips the fallback on next sync.

### B. Backfill existing iOS-only photos (fix Chanell)

Root cause: photo sync fires on iOS `PUT` after the feature shipped or on Google pull. Chanell's photo was set on iOS before that, and CardDAV has no way for the server to *ask* iOS for a specific contact's photo — iOS only pushes on user edit.

Two-pronged fix:

1. **Google pull sweep (immediate for Google-linked contacts):** add a one-shot "Backfill contact photos from Google" server fn that ignores the `photo_etag` short-circuit and re-fetches photo bytes for every linked contact whose `avatar_url` is null. Runs in the existing pull lease. Button on `settings.google-contacts.tsx`. This alone likely fixes Chanell if she's in Google Contacts.
2. **CardDAV nudge for the rest:** add a per-contact "Request photo from iPhone" action in the contact drawer that (a) bumps `updated_at` + per-contact ETag, (b) writes a marker so the next `PUT` that arrives without a `PHOTO` line is treated as "iOS still hasn't sent it" (no-op) but a `PUT` *with* `PHOTO` overwrites as normal. Combined with a settings note explaining iOS only pushes photos when the user opens & edits the card, this gives you a clear manual recovery.

### C. Diagnostics

Small drawer entry under contact → "Photo status": shows source (`user` / `logo:acme.com` / `none`), last pulled from Google, last pushed to iOS/Google. Makes future "why is X not showing" trivial.

## Technical notes

- Schema: `ALTER TABLE contacts ADD COLUMN logo_photo_domain text, ADD COLUMN logo_photo_etag text;` — no RLS change needed.
- Logo fetch reuses `src/lib/logo-guards.ts` + provider list in `src/lib/logo-providers.ts`. Cache in `contact-photos` bucket at `logo/<domain>/<providerIdx>` and serve via signed URL for the UI (matches the private-bucket pattern we just landed).
- Google push: `updateContactPhoto` already accepts bytes; add an `if (fallbackLogo && !avatar_url)` branch in `push.server.ts`, gated on etag change.
- Backfill fn adds one flag `{ mode: "force_photos" }` to the existing pull loop rather than a whole new path.
- No changes to encryption or existing RLS.

## Out of scope

- Auto-generating a stylized initials avatar when there's no company either (still shows the orange C).
- Watching Google for photo changes in near-real-time (still on the 5-min cron).