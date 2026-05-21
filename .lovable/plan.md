## What's actually happening

Severin's email **is** in the system — it was enqueued as a `message_jobs` row at 21:49 UTC for tpercoco@nucar.com (gmail_message_id `19e4c83c27dc9726`). It just hasn't been *processed* yet, which is why:

- Gmail still shows it in the inbox → the app hasn't applied the `Factory` label yet
- The app's inbox doesn't show it → the `emails` row hasn't been written yet

**Why it's stuck:** The job queue has **39,599 pending jobs** ahead of it, almost all from the in-flight backfill (42,180 found / 39,873 enqueued, still listing). The worker pulls FIFO by `next_run_at`, and the backfill jobs were enqueued at 20:52 — earlier than Severin's 21:49 push job. At ~25 jobs/min, live mail is hours behind.

There's also one job stuck in `running` for ~56 min (from 20:58) that the self-heal should have reclaimed — worth checking the process-jobs cron is actually firing.

## Plan

### 1. Prioritize live (push/poll) mail over backfill — primary fix

Give backfill-enqueued jobs a deprioritized `next_run_at` so push/poll jobs always jump the line.

- In `enqueueMessageJob` (`src/lib/sync.server.ts`), add an optional `source: "live" | "backfill"` arg.
- For `"backfill"`, set `next_run_at = now() + 24h` (or use a separate sort key — see Technical notes).
- Update the backfill tick (`gmail-backfill-tick.ts` / `sync.server.ts` backfill path) to pass `"backfill"`.
- Leave webhook/poll callers as default `"live"` (now).

Result: any newly pushed message is claimed by the worker on the next tick (≤60s), regardless of backfill backlog depth.

### 2. Unblock and verify the worker

- Check the `gmail-process-jobs` cron schedule exists and is firing every minute (the 56-min stuck `running` row suggests it may not be).
- Manually kick `/api/public/gmail-process-jobs?limit=50` once to clear the head of the queue and confirm Severin's job processes.
- Bump per-tick `limit` from 25 → 50 so backfill still drains in reasonable time.

### 3. Verify the fix

- Confirm Severin's job moves from `pending` → processed.
- Confirm an `emails` row exists with `folder_id = Factory` and `is_archived = true`.
- Confirm Gmail-side: `INBOX` label removed, `Factory` label applied.
- Send a fresh test email from an hmausa.com address and confirm it routes within ~1 min while backfill continues in the background.

## Technical notes

- Two implementation choices for prioritization:
  - **Simple:** push backfill jobs to `next_run_at = now() + 24h`. Live jobs (`now()`) always sort first. Backfill still processes when live queue is empty because the worker's `lte("next_run_at", now())` filter will pick them up after 24h — so we'd instead need to make the worker run a "live-first, then backfill" two-pass query, OR
  - **Cleaner:** add a `priority smallint` column (0 = live, 10 = backfill), `ORDER BY priority ASC, next_run_at ASC`. Requires a small migration + index `(status, priority, next_run_at)`.
- Recommend the cleaner option — one migration, no semantic abuse of `next_run_at`.
- No UI changes. Backfill banner continues to work as-is.

## Files to change

- `supabase/migrations/<new>.sql` — add `priority` column + index on `message_jobs`.
- `src/lib/sync.server.ts` — `enqueueMessageJob` accepts `source`/`priority`; `runMessageJobs` orders by `(priority, next_run_at)`; bump default limit.
- `src/routes/api/public/gmail-backfill-tick.ts` (or wherever backfill enqueues) — pass backfill priority.
