## Problem

The DLQ is full of rows with `stuck (worker timeout — exceeded max attempts)` — messages whose worker died mid-processing (Cloudflare 25s wall-time), got reclaimed, died again, and were parked. None have a `from_addr` / `subject` because the DLQ metadata fetch only runs in `handleError`, not in `reclaimStuckJobs`.

Two things to do:

1. **Drain the current backlog** — auto-replay these `stuck` DLQ rows. `isTransientDlqError` in `src/lib/sync/dlq.ts` doesn't currently match `stuck (worker timeout…)`, so `replayTransientDlq` skips them. Add a pattern for it. One manual tick of `/api/public/gmail-dlq-replay` then flushes the backlog back to `pending` with fresh attempts and jittered `next_run_at`.

2. **Stop the bleed** — the reason jobs time out repeatedly is the 25s hard cap in `runMessageJobs` racing Gmail fetch + AI + DB. For the stuck-reclaim path specifically, make the second failure land in DLQ with metadata (from/subject) so operators can actually see what's stuck, and lower the reclaim's attempt bump so a single transient stall doesn't burn the whole budget.

## Changes

**`src/lib/sync/dlq.ts`**
- Add `/stuck \(worker timeout/i` (and a matching test case) to `TRANSIENT_DLQ_PATTERNS` so `replayTransientDlq` picks these up.

**`src/lib/sync/queue.ts` — `reclaimStuckJobs`**
- On the DLQ branch (second stuck in a row), best-effort fetch `from_addr` / `subject` via `getMessageMetadata` + `parseMessage` (same shape as `handleError`) so the operator DLQ table isn't all `—`.
- Keep the free-first-reclaim behavior; only the DLQ transition changes.

**One-off drain**
- After deploy, hit `/api/public/gmail-dlq-replay` once (existing endpoint, `CRON_SECRET`-gated) to flush the backlog. No new endpoint needed.

## Out of scope

- Not changing `JOB_TIMEOUT_MS` or `MAX_JOB_ATTEMPTS` — the timeout matches Worker wall-time and lowering attempts would DLQ faster, not less. If genuine slow-Gmail/slow-AI is the root cause we'd tackle that separately (batch size, prefetch, model choice) once the replayed jobs show whether they still time out.
- Not touching `claim_message_jobs` RPC or the queue worker pool.

## Acceptance

- Unit test in `src/lib/sync-dlq.test.ts` asserts `isTransientDlqError("stuck (worker timeout — exceeded max attempts)")` is true.
- Manual dlq-replay tick moves the screenshotted rows out of `dlq` back to `pending`.
- New `stuck→dlq` rows created after the change show `from_addr` / `subject` in the operator UI.
