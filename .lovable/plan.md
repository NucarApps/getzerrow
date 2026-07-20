## Goal

When a photo is uploaded to Zerrow (contact photo uploader), it should:
1. Push to CardDAV so iOS pulls the updated picture on the next sync.
2. Honor the effective per-contact photo priority (personal vs company first) — no forced override; the setting the user configured is respected as-is.

Today `uploadContactPhoto` saves the image and marks Google-linked contacts dirty, but does not bump the CardDAV resync nonce, so iPhones don't see the change until an unrelated sync happens. It also doesn't touch photo priority (correct — Zerrow uploads shouldn't auto-flip preference; the display resolver already honors whatever priority is set).

## Changes

1. **`src/lib/contacts/photos.functions.ts`** — in `uploadContactPhoto.handler` (after the successful `saveContactPhoto` and Google dirty-marking):
   - Bump the CardDAV resync nonce via existing `bumpResyncNonce(context.supabase, context.userId)` from `@/lib/carddav/settings.functions`. Wrap in try/catch — non-fatal.
   - Do the same in `removeContactPhoto.handler` so removals also propagate to iOS.

2. **CardDAV serve path** — verify `loadContactPhotoOrLogo` in `src/lib/carddav/handlers.server.ts` already uses `getEffectivePhotoPriority` (it does, from the earlier photo-priority work), so iOS will receive personal-vs-company per the resolved preference automatically once the resync nonce triggers a refresh. No changes needed there.

3. **Logging** — add a structured `carddav.resync_nonce_bumped` event with `contact_id` and `reason: "photo_upload"` / `"photo_remove"` for traceability.

## Non-goals

- No change to the photo-priority resolver — Zerrow uploads honor whatever the effective priority is (contact override → company → global default).
- No auto-switch of `photo_priority` on Zerrow upload. (The earlier CardDAV iOS PUT plan handled the iOS-side auto-switch to `personal_first`; Zerrow uploads keep the user's chosen preference intact.)
- No schema changes.

## Technical notes

- `bumpResyncNonce` is the standard mechanism used elsewhere (label rules, priority changes) to force iOS/other CardDAV clients to re-fetch — same lever here.
- The photo remains stored as `avatar_source="user_upload"`, so the self-heal in `getContact` won't wipe it.
