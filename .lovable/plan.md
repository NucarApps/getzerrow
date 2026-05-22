## What I found

The "$50K on the table" email from `justin.rank@stellantis.com` is **not in the database**. Pushes for `chris@nucar.com` arrived continuously (343 pushes in the last hour) and the job queue currently has **18 pending jobs**, including two stuck since 13:31 with `stuck (worker timeout) — auto-reclaimed` after multiple retries. So this isn't a "push didn't arrive" problem — it's a **processing-throughput** problem. New mail enqueues fine, but the worker can't keep up, and individual jobs occasionally hit the 25 s per-job timeout and cycle back as retries.

Three concrete causes:

1. **Webhook drains too little inline.** `gmail-webhook.ts` only runs `Math.min(enqueuedCount, 10)` jobs after enqueueing. When a burst pushes many messages, the rest wait up to 30 s for the cron tick.
2. **Stuck-job recovery is too lazy.** `runMessageJobs` only reclaims jobs whose `locked_at` is older than **90 s**, and the per-job timeout is 25 s. A worker that dies silently (Cloudflare request timeout, AI gateway hang) blocks that job for a minute and a half before any retry, and on retry it goes back to the end of the queue.
3. **No visibility into which step is slow.** When a job hits the 25 s timeout we log `"job timeout after 25000ms"` but not which phase (Gmail fetch, AI classify, DB write). I can't tell whether to raise the timeout, lower concurrency, or shrink the AI prompt.

## Changes

### 1. Drain harder on every push (`src/routes/api/public/gmail-webhook.ts`)
- Replace `Math.min(enqueuedCount, 10)` with `runMessageJobs(50, 16, { priority: 0 })` — i.e. always try to drain up to 50 high-priority (live) jobs after enqueueing, not just the ones we just added. This keeps the queue near empty during bursts instead of waiting for cron.
- Keep it bounded to live-priority jobs so a backfill backlog doesn't starve new mail.

### 2. Faster stuck-job recovery (`src/lib/sync.server.ts`, `runMessageJobs`)
- Drop `STUCK_MS` from **90 s → 35 s** (safely above the 25 s per-job timeout). A dead worker's job becomes claimable again on the next cron tick instead of ~90 s later.
- When auto-reclaiming a stuck job, set `next_run_at = now()` and **don't** count the reclaim as a failed attempt unless it has been reclaimed twice in a row. Currently every reclaim burns one of 5 attempts, so two transient hiccups DLQ the message.

### 3. Diagnostic timing (`src/lib/sync.server.ts`, `processGmailMessage` + `processOne`)
- Wrap the three phases (Gmail fetch, AI classify, DB upsert) with `performance.now()` and include them in the `last_error` string when a job times out: `"job timeout after 25000ms (fetch=4200 ai=20100 db=0)"`.
- Log nothing on success — only on timeout/error — so we don't add noise.

### 4. Sanity check: confirm the $50K email
- After deploying, re-query `emails` for `subject ilike '%50K on the table%'` to verify it now lands. If it's already in Gmail's INBOX but no `message_jobs` row exists, that means the push for that message never reached us — different problem (Gmail watch / Pub/Sub) and I'll dig into `pubsub_events` for that exact `historyId`. The current 487 push events in 2 h say the watch is healthy, so I expect the email to appear once the backlog clears.

## Out of scope

- Raising the 25 s per-job timeout (Cloudflare Worker subrequest budget makes this risky — fix the slow step instead).
- Restructuring the AI call into a streaming or smaller-model path. The timing logs from change #3 will tell us if that's needed next.
- UI changes to the Sync activity panel.

## Files touched

- `src/routes/api/public/gmail-webhook.ts` — one-line change to the inline drain.
- `src/lib/sync.server.ts` — adjust `STUCK_MS`, reclaim-attempt logic, and add phase timings around `processGmailMessage`.

No schema migration, no new endpoints.
