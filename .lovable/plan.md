## What's actually happening

Every cron-triggered HTTP call is returning **401 Unauthorized** right now. The last 10 minutes of `net._http_response` is a wall of 401s — `gmail-process-jobs-30s`, `gmail-process-live-5s`, `gmail-poll-2m`, `gmail-backfill-tick`, `relearn-folders` — none of them are reaching your worker successfully.

That's why the queue piles up and only the **Drain queue now** button works: that button calls a server function from your logged-in session, which bypasses `isAuthorizedCron` entirely.

## Root cause

The recent security hardening rewrote `isAuthorizedCron` (`src/lib/cron-auth.server.ts`) to **only** accept `Authorization: Bearer <CRON_SECRET>` or `x-cron-secret: <CRON_SECRET>`, where `CRON_SECRET` comes from `process.env.CRON_SECRET` on the worker.

The pg_cron side has two different problems:

1. **`gmail-process-live-5s` (jobid 14)** and **`relearn-folders-hourly` (jobid 16)** still only send the old `apikey: <anon-key>` header. With the anon-key branch removed, these now always 401.

2. **All the other jobs** (`gmail-process-jobs-30s`, `gmail-poll-2m`, `gmail-backfill-tick`, `gmail-reconcile-15m`, `gmail-renew-watches`, `run-folder-summaries`) DO send `Authorization: Bearer <cron_secret>` (via `private.cron_post`, which reads from `private.cron_settings`). They're **also** 401ing — which means the `cron_secret` stored in `private.cron_settings` does not match the `CRON_SECRET` env var on the deployed worker (or `CRON_SECRET` is missing on the worker entirely).

## Fix plan

Two coordinated changes, then verify.

### 1. Sync the secret on both sides

- Confirm what value the worker's `process.env.CRON_SECRET` is currently set to. If it isn't set, set it via the Secrets tool to the same 64-char value that's already stored in `private.cron_settings.cron_secret` (or pick a fresh one and update both).
- Update `private.cron_settings` so its `cron_secret` row matches the worker's `CRON_SECRET` exactly.

### 2. Rewrite the two jobs that still use the anon key

Reschedule `gmail-process-live-5s` and `relearn-folders-hourly` so they route through `private.cron_post(...)` like every other job (which already attaches `Authorization: Bearer <cron_secret>`). Drop the hard-coded `apikey: ...` headers from the job bodies — they're no longer accepted and shouldn't be in cron.job DDL anyway.

End state for those two jobs:

```sql
-- gmail-process-live-5s
SELECT private.cron_post('/api/public/gmail-process-jobs?limit=25&priority=0');

-- relearn-folders-hourly
SELECT private.cron_post('/api/public/hooks/relearn-folders');
```

### 3. Verify

After the migration:
- Watch `net._http_response` for ~30s and confirm new rows are 200, not 401.
- Confirm `message_jobs` `pending` count drains on its own without touching the **Drain queue now** button.
- The "Processing delay" and "Fallback poll hasn't run in 24h+" banners in the Sync activity panel should clear within a couple of minutes.

## Out of scope

- No changes to `isAuthorizedCron` — the stricter auth is correct and matches the integration tests in `tests/public-endpoints-auth.test.ts`.
- No changes to the worker code itself, the UI, or any of the server functions. The endpoints are fine; only the cron-side credentials are broken.
