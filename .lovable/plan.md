## Goal
Make sure photos we hold locally (Zerrow uploads, iPhone/CardDAV uploads, company‑logo resets) reliably reach Google Contacts on the next sync.

## What's actually broken today

I traced the local → Google push in `src/lib/google-contacts/push.server.ts`:

1. **New Google contacts never get their photo.** In `pushContacts`, we look up `link` from `google_contact_links` *before* the loop. When `!link` we call `createPerson` and insert a fresh link row, but the local `link` / `linkRow` variables aren't refreshed. The photo block at line ~301 then reads `currentLink?.resource_name`, gets `undefined`, and silently skips. Because the contact's `updated_at` won't bump again by itself, the photo is effectively never pushed for any contact created via Zerrow.
2. **Photo‑only edits don't push unless something re‑dirties the link.** `uploadContactPhoto` / `removeContactPhoto` in `src/lib/contacts/photos.functions.ts` and CardDAV PUT in `handlers.server.ts` set `last_synced_at = 1970` so they're dirty — good. But `resetContactToCompanyLogo` in `src/lib/contacts/crud.functions.ts` and the `company-logo-cleanup` path don't call `markGoogleContactDirty`, so switching a contact back to a company logo never propagates.
3. **Photo push failures are swallowed and never retried.** The `catch (photoErr)` logs and moves on, and because we only re‑attempt when `avatar_url !== photo_etag`, a transient Google 5xx leaves `photo_etag` at its old value; next cycle the URLs still differ but the contact is no longer dirty, so we don't even enter the loop body.

## Fix

### `src/lib/google-contacts/push.server.ts`
- After `createPerson` succeeds, hydrate a local `linkRow` with the new `resource_name` and set a synthetic `photo_etag: null` so the photo block below runs in the same iteration.
- Change the outer skip at line 154 so that a contact with a non‑null `avatar_url` and `avatar_url !== link.photo_etag` counts as dirty even when body fields aren't. This makes retries actually retry.
- On photo push failure, clear `photo_etag` to `null` (not the current `avatar_url`) so the next cycle re‑enters the branch, and bump a small `photo_push_attempts` counter (add column) to cap retries at ~5 before giving up with a logged alert.

### `src/lib/contacts/photos.functions.ts`
- Extract `markGoogleContactDirty` into a shared helper `src/lib/google-contacts/mark-dirty.server.ts` and reuse it.

### `src/lib/contacts/crud.functions.ts`
- Call the shared `markGoogleContactDirty` from `resetContactToCompanyLogo` and from the self‑heal path that nulls `avatar_url`, so company‑logo changes flow to Google.

### `src/lib/companies/company-photo.functions.ts`
- Already marks members dirty on company‑photo change; keep as‑is, just switch to the shared helper.

### Migration
- Add `photo_push_attempts int not null default 0` to `google_contact_links` (with grants unchanged — table already has service_role access).

## Tests
- Extend `src/lib/google-contacts/push.server.ts` coverage with a unit test that: (a) creates a new contact with an avatar and asserts `updateContactPhoto` is called in the same run; (b) simulates a transient photo error and asserts the next run retries; (c) after 5 failures, asserts we stop retrying and log the alert.
- Add a test for `resetContactToCompanyLogo` verifying it marks the Google link dirty.

## Out of scope
- Pull direction (Google → local) — that path already handles photos correctly per `photo-pull-decision.ts` and the user asked to focus on push.
- CardDAV photo flow — unchanged.
