
## What's happening

The Google Contacts sync isn't stuck in Google — it's stuck on our side.

`google_sync_state` for your Gmail account currently has:

- `locked_at = 22:58:11` (about 2 minutes ago and counting)
- `last_error = People API 400 on /contactGroups … Invalid groupFields mask path: "formatted_name"`
- `updated_at` identical to `locked_at`

That's the fingerprint of a sync run that acquired the in-DB lease, hit the (now-fixed) `formatted_name` error, and got killed by the worker mid-handler before the `catch` block could clear the lock. `reconcile.server.ts` refuses to start a new run while `locked_at` is under 5 minutes old, so every "Sync now" click returns `{ ok: false, error: "locked" }` and the UI just re-polls and keeps spinning until the lease naturally expires.

The `formatted_name` fix is already in `people-client.server.ts` (`CONTACT_GROUP_LIST_FIELDS = "name,groupType"`), so once the lock is cleared the next run should actually reach Google and succeed.

## Fix

1. **Release the stuck lease now.** One-off UPDATE on `google_sync_state` setting `locked_at = null` and `last_error = null` for the affected row so the next "Sync now" starts fresh.

2. **Shrink the lease + always release it.** In `src/lib/google-contacts/reconcile.server.ts`:
   - Drop the stale-lease window from 5 minutes to **90 seconds** (the pull+push flow finishes in well under that; longer just prolongs wedge time).
   - Wrap the pull/push work in `try / catch / finally` so the lock is cleared in a `finally`, not only in the `catch`. That way even if the handler is aborted after the throw (worker timeout, client disconnect), the *next* run's own stale-lease check reclaims it within 90 s instead of 5 min.
   - Keep the existing `last_error` semantics — clear on success, set on failure.

3. **Surface locked state clearly in the UI.** In `src/routes/_authenticated/settings.google-contacts.tsx`:
   - When `syncNow` resolves with `error: "locked"`, show the existing "Another sync is already running" toast (already wired via `friendlyError`) *and* tell the user it will retry within ~90 s.
   - No auto-unlock button — the shorter lease makes it unnecessary and a manual override risks racing a real in-flight run.

4. **Verify.** After the migration/edit, click "Sync now" once and confirm via `google_sync_state` that `last_incremental_at` bumps, `last_error` clears, and `last_pull_count` reflects your Google contacts count.

## Technical notes

- No schema change. Just a data update + code edits in `reconcile.server.ts` and `settings.google-contacts.tsx`.
- The 15-minute cron and manual "Sync now" both go through `runGoogleContactsSync`, so the finally-based cleanup covers both paths.
- Nothing changes for `people_sync_token` / `groups_sync_token` — they stay null so the next run does a full pull (which is what we want after the previous failure).
- Does NOT touch the OAuth reconnect / contacts-scope handling — those paths were already resolved earlier this session and are working.

## Out of scope

- Retrying a background job automatically after a lease reclaim (the 15-min cron already covers that cadence).
- Streaming progress to the UI. Current 15 s polling is fine for a run that finishes in a few seconds.
