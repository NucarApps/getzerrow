# Speed up the 6-month backfill

## Where the time is going

- Backfill **listing** (paginating Gmail to enqueue message jobs) is fast — that part already shows tens of thousands "found".
- Backfill **processing** (fetch each message + write to DB + apply Gmail labels) is the bottleneck. That's the "300 of 37,000" number you see.
- Today the worker (`runMessageJobs` in `src/lib/sync.server.ts`) processes jobs **one at a time in a `for…of` loop**. Each job does a Gmail GET + a few Supabase writes, ~500ms–1s wall time. At 25 jobs per 30s tick = ~50/min = ~3,000/hr, 37k messages takes ~12 hours.
- Almost all of that time is **network I/O waiting** (Gmail API + Supabase). Cloudflare Workers don't bill wall-clock for I/O, so we can safely run many jobs in parallel inside one tick.

## What I'll change

1. **Parallelize the worker** (`runMessageJobs` in `src/lib/sync.server.ts`)
   - Replace the sequential `for (const job of candidates)` loop with a bounded-concurrency pool (concurrency ~8). Each worker independently claims (compare-and-set update on `status=pending → running`), processes, and finalizes its own job. The existing per-job try/catch, timeout, DLQ, and backoff logic stays intact — we just run N of them at once.
   - Keep the 25s per-job hard timeout so a slow Gmail call can't stall the whole batch.

2. **Bigger per-tick batch**
   - Bump the default `limit` in `runMessageJobs` from 50 → 100, and the cap in `/api/public/gmail-process-jobs` from 100 → 200.
   - Update the `gmail-process-jobs-30s` cron to call `?limit=100`.

3. **Keep live mail prioritized**
   - The existing `ORDER BY priority, next_run_at` already keeps live pushes ahead of backfill — no change needed.

4. **Verify**
   - After deploy, watch `message_jobs` count drop and `backfill_jobs.processed` climb. Expected throughput: ~400–800 jobs/min (vs 50/min today), finishing 37k in roughly 1–2 hours instead of ~12.
   - Confirm no spike in DLQ or rate-limit errors. If Gmail starts returning 429s, dial concurrency from 8 → 5.

## Files touched

- `src/lib/sync.server.ts` — concurrency pool in `runMessageJobs`, raise default limit
- `src/routes/api/public/gmail-process-jobs.ts` — raise max `limit` cap
- One SQL call (not a migration) to update the `gmail-process-jobs-30s` cron URL to `?limit=100`

## Out of scope

- No schema changes, no new tables, no UI changes. The BackfillBanner progress bar will simply move faster.
