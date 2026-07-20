## What's happening

Both symptoms have the same root cause: `runGoogleContactsSync` is invoked **inline** from the UI request and can exceed Safari's ~30-60s fetch wall.

1. **"Sync to Google now" for Roberta → Load failed.** `pushContactPhotoToGoogleNow` (`src/lib/google-contacts/push-photo-now.functions.ts`) marks the link dirty and then awaits `runGoogleContactsSync(...)` per linked account. That call runs the whole pull + push loop (up to `MAX_CONTACTS_PER_RUN = 200` including photo bytes, no wall-clock budget in `push.server.ts`). Safari drops the request as "Load failed" while the Worker keeps running until it's killed — and when the Worker is killed mid-push, the `finally` in `runGoogleContactsSync` may not run, so `locked_at` stays set.

2. **Full resync stuck at 29.** Same story from `forceFullGoogleContactsResync` + `syncGoogleContactsNow` in `settings.google-contacts.tsx`. The progress row is updated as the push loop advances (last processed = 29), the request is cut, the lease stays held, and while the UI polls every 1s it just re-reads the same 29. `LEASE_STALE_MS = 90s` eventually clears it, but by then the user has clicked again and hit "locked".

## Fix

Make sync calls from the UI **fire-and-forget** and give the push loop a real wall-clock budget so it can't wedge again.

### 1. `src/lib/google-contacts/push-photo-now.functions.ts`
- Keep the ownership check + `resolveEffectiveContactPhotoForSync` pre-check + `markGooglePhotoDirty(...)`.
- Replace the sequential `await runGoogleContactsSync(...)` loop with a fire-and-forget dispatch of one background run per linked account using `waitUntil`-style `void`ed promise (or a short `POST` to `/api/public/hooks/google-contacts-sync` with `CRON_SECRET`). Return immediately with `{ contactsMarked, accountsQueued }` so the toast becomes "Queued sync — photo will appear in Google shortly" instead of blocking.
- Same treatment for `pushCompanyPhotoToGoogleNow`.

### 2. `src/lib/google-contacts/push.server.ts`
- Add a `PUSH_WALL_BUDGET_MS` (~18s) checked between contacts in the push loop (and between photo uploads). When exceeded, log `google_contacts.push.budget_exceeded`, break out cleanly, and let the next cron tick pick up the rest. This mirrors `CATCHUP_TOTAL_BUDGET_MS` in the Gmail sync lane so we finish under the Worker limit and the `finally` in `runGoogleContactsSync` actually runs → lease releases.

### 3. `src/lib/google-contacts/reconcile.server.ts`
- Drop `LEASE_STALE_MS` from 90s to 30s so a genuinely killed run recovers faster next click. (Compatible with the new push budget: a healthy run now finishes well under 30s.)
- On the "locked" early-return, include `last_progress_processed` in the returned error payload so we can log/toast "another sync is already in progress" instead of appearing stuck.

### 4. `src/routes/_authenticated/settings.google-contacts.tsx` (thin UI wiring only)
- Change the `forceMut` / `syncMut` `onSuccess` copy to reflect the async model: "Sync started — this can take a minute for large accounts." No behavior change beyond messaging; the existing 1s poll on `locked_at` already surfaces progress.

### Verification
- Manual: click "Sync to Google now" on Roberta → toast is instant, `google_contact_links.photo_etag` clears, `google_sync_state.locked_at` sets then clears within one budget window, photo appears in Google People.
- Manual: click "Force full re-pull" → UI shows progress advancing past 29, lease releases cleanly.
- Log check: `google_contacts.push.budget_exceeded` fires only on large accounts and the following cron tick completes the remainder.
- Regression: `src/lib/google-contacts/dirty.test.ts` still green; no schema changes.

No DB migration needed.