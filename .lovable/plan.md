## Diagnosis (unconfirmed until we open dad's row, but strongly supported by the code)

The CardDAV `PUT` in `src/lib/carddav/handlers.server.ts` (line 1234) saves iPhone-uploaded photos with `avatar_source: "carddav"`. The `getContact` self-heal in `src/lib/contacts/crud.functions.ts` (lines 163–256) then treats **any avatar whose source isn't `"user_upload"`** as a candidate to be wiped if it looks like a company logo. It runs whenever the contact has a `company_id` (which can be auto-assigned from an email domain even when you didn't set the company yourself).

The likely loop that produces "photo saves, then gets replaced later":

```text
iPhone save (PUT) → saved as source="carddav"
  → you (or a background render) open the contact in Zerrow
  → getContact self-heal fires → deletes avatar_url
  → iPhone next sync → GET returns company-logo fallback
  → iPhone stores the logo as the contact's photo
```

Net effect: your dad's picture on iPhone silently becomes a logo/initial some time after you save it.

## Fix

1. **Treat iPhone CardDAV uploads as authoritative user uploads.**
   - In `src/lib/carddav/handlers.server.ts` change the `saveContactPhoto(..., "carddav")` call to `"user_upload"`. Once a human uses the iPhone Contacts app to set a picture, the self-heal must never wipe it.

2. **Defensively exempt legacy `"carddav"` rows.**
   - In `src/lib/contacts/crud.functions.ts` widen the guard `avatarSource !== "user_upload"` to also skip when `avatarSource === "carddav"`, so any existing rows saved before fix #1 stop getting wiped.

3. **One-time backfill for already-wiped contacts.**
   - Run a `supabase--read_query` first to confirm the pattern on your account: how many contacts have `avatar_source = "carddav"` and how many have `avatar_url IS NULL` with a non-null `company_logo_photo_sha` (the fingerprint the self-heal leaves behind). No destructive backfill is needed — iPhone still holds the original bytes and will push them back on the next PUT once fix #1 is in place. If we find rows where the local photo was deleted but iPhone hasn't re-uploaded, we can bump `resync_nonce` (existing mechanism) so iOS re-pushes.

4. **Regression test.**
   - Extend `src/lib/carddav/photo-echo.test.ts` with a case: after `handlePut` saves a real (non-logo) photo, calling `getContact` on a contact with a `company_id` must leave `avatar_url` intact.

5. **Verify against your dad's contact** with a targeted `supabase--read_query` on `contacts` (id, avatar_source, company_id, company_logo_photo_sha, updated_at) before and after the fix so we can confirm the behavior stopped.

## Scope guardrails

- No changes to the company-logo fallback behavior for contacts that never had a user-chosen photo — logos still auto-fill blanks.
- No changes to the PUT-side echo guard (`buildKnownCompanyLogoShaSet`) — it still blocks iOS from re-uploading a logo it received as a fallback.
- No Google push/pull changes.

## Files touched

- `src/lib/carddav/handlers.server.ts` (1-line source label change)
- `src/lib/contacts/crud.functions.ts` (widen guard)
- `src/lib/carddav/photo-echo.test.ts` (new test)