## Root cause (confirmed)

The Google Contacts sync cron endpoint has been returning **401 Unauthorized on every 5‑minute tick for the last 2+ days**, so no pull/push has actually run.

Confirmed by:
- Worker logs: every `POST /api/public/hooks/google-contacts-sync` → 401 (last hour, and pattern is continuous).
- `google_sync_state` for `chris@nucar.com`: `last_incremental_at = 2026-07-18 14:17`, `locked_at` stuck at `2026-07-20 04:40` from the last run that actually got in.
- `cron.job_run_details` shows pg_cron dispatches every 5 min succeeded (they only report the `net.http_post` enqueue, not the HTTP response).
- `gmail_accounts`: `needs_reconnect=false`, `contacts_access=true` — auth to Google is fine.

Why 401: pg_cron sends `Authorization: Bearer <private.cron_settings.cron_secret>`. The endpoint validates with `isAuthorizedCron` (env‑only, checks `process.env.CRON_SECRET`). The DB‑stored cron secret and the worker env `CRON_SECRET` don't match, so the check fails. Every other cron endpoint (e.g. `gmail-poll`) uses `isAuthorizedCronRequest`, which also falls back to `cron_secret_matches` RPC against `private.cron_settings` — that's why they return 200 while this one 401s.

`src/routes/api/public/hooks/google-contacts-sync.ts` is the only public hook still on the sync-only helper.

## Fix

1. In `src/routes/api/public/hooks/google-contacts-sync.ts`:
   - Replace `isAuthorizedCron` with `await isAuthorizedCronRequest(request)`.
   - Replace the local `unauthorized()` helper with the shared `unauthorizedResponse()` for consistency.
2. Clear the stuck lease so the next cron tick isn't blocked (belt‑and‑suspenders — code already reclaims after 30 s, but let's not wait):
   - `UPDATE google_sync_state SET locked_at = NULL, progress_step = NULL WHERE locked_at IS NOT NULL;`
3. Verify:
   - Watch worker logs for `google-contacts-sync → 200` on the next 5‑minute tick.
   - Re‑query `google_sync_state`: `last_incremental_at` should advance, `last_pull_count`/`last_push_count` should update, `last_error` stays null.
   - Spot‑check that queued dirty rows (`google_contact_links` with `photo_etag IS NULL` or sentinel `last_synced_at`) drain over subsequent runs.

## Out of scope

No changes to pull/push logic, mapping, or photo handling — those paths work; they just haven't been running.
