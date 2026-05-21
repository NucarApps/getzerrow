## The republish theory isn't the cause

Republishing does briefly take the webhook offline (under a minute typically), but Google Pub/Sub retries pushes with exponential backoff for ~7 days, so missed pushes are normally recovered on the next attempt — and the next push triggers `syncSinceHistory` from the last stored `history_id`, which catches up everything in between.

## What's actually happening (verified in your data)

Two real problems:

### 1. The poll cron stopped firing 18 hours ago
The most recent `event_type='poll'` row in `pubsub_events` is from **2026-05-21 01:02 UTC** — nothing since. The `/api/public/gmail-poll` endpoint is a manual cron call (scheduled externally via pg_cron / a scheduler that hits the URL with `CRON_SECRET`). Whatever was calling it stopped.

This poll is your safety net for missed Pub/Sub pushes **and** the main drain for `message_jobs`. With it off, anything the webhook doesn't process inline just sits.

### 2. `message_jobs` is backlogged because nothing else is draining it
- **92 pending jobs**, attempt=0, no errors, oldest enqueued **16 min ago**.
- All are unlocked (no stuck workers).
- The only drain currently running is the inline `runMessageJobs(min(enqueued+5, 25))` call inside the webhook handler. When a push enqueues 1 new message, it drains ≤6 jobs — slower than the inflow during bursts.
- There's no evidence the `/api/public/gmail-process-jobs` endpoint has ever been called (no separate cron log for it).

That's why you periodically see emails in Gmail that haven't been processed in your inbox — they're sitting as `pending` jobs waiting for a worker that isn't running.

## Plan

### A. Re-arm the cron jobs (root cause)
Restore the two scheduled callers. Recommended cadence:
- `POST /api/public/gmail-poll` — every 2 minutes (safety net + extra drain)
- `POST /api/public/gmail-process-jobs?limit=50` — every 30 seconds (primary drain)

Both must send `Authorization: Bearer <CRON_SECRET>` (the secret is already set in this project's environment). This is configured outside the codebase — typically pg_cron in Supabase using `net.http_post`. I'll add a migration that creates both schedules so they're recreated automatically across publishes.

### B. Make the webhook drain bigger when backlog is present
In `src/routes/api/public/gmail-webhook.ts`, after `syncSinceHistory`, check the pending count for this user's accounts. If it's >25, raise the inline drain limit (e.g. `min(pending+5, 100)`) so a single push can chew through accumulated work instead of always capping at 25. Keep the cap so we don't exceed the per-request CPU budget.

### C. One-time backlog flush
Hit `gmail-process-jobs?limit=100` once or twice after the fix lands to clear the current 92 pending jobs. I can do this with `invoke-server-function`.

## Out of scope
- Changing the Pub/Sub subscription itself (URL/token are fine — pushes are arriving normally, 97 in the last 30 min).
- Republish behavior (not the cause; brief deploy gaps are recovered by Pub/Sub retries and the next history sync).

## Files touched
- `supabase/migrations/<ts>_gmail_cron_schedules.sql` — pg_cron jobs for poll + process-jobs.
- `src/routes/api/public/gmail-webhook.ts` — adaptive drain limit when backlog detected.