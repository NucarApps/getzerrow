# Drain the 38k-message backfill faster

## Where we are

- Queue right now: **15,595 priority-0** (live) + **22,529 priority-10** (backfill) = ~38k pending.
- Worker config today: `runMessageJobs(limit=100, concurrency=8)` fired once every 30s by `gmail-process-jobs-30s` cron → theoretical ceiling **~800 jobs/min**, real-world ~400–600/min because each Cloudflare Worker invocation has startup overhead and not every job finishes inside the 25s timeout.
- That still puts a 38k drain at ~60–90 min, and you're seeing it lag well behind that. The single-invocation-per-tick model is the ceiling — one Worker, one batch, one wall-clock window.

## The fix: fan out + more concurrency per worker

We can do BOTH without schema or UI changes:

1. **Fan out the cron tick** — change the `gmail-process-jobs-30s` cron to fire **4 parallel `net.http_post` calls** per tick instead of 1. Each call is an independent Cloudflare Worker invocation with its own 25s wall budget. That's 4x the parallelism for free.

2. **Raise per-worker concurrency** from 8 → **16** in `runMessageJobs`. Each job is ~95% I/O wait (Gmail GET + Supabase writes), so 16 in-flight per Worker is safe — Cloudflare doesn't bill wall time on I/O, and Gmail's per-user quota (250 quota units/sec) is nowhere near saturated at this rate.

3. **Keep per-tick `limit` at 100** — with 4 parallel invocations claiming jobs via compare-and-set on `status=pending → running`, each gets a distinct slice. No double-processing risk.

4. **Net effect**: 4 invocations × 100 jobs × (16 concurrent / ~0.8s per job) ≈ **~2,000–4,000 jobs/min**. 38k drains in **~10–20 minutes**.

5. **Live mail still wins** — `ORDER BY priority ASC, next_run_at ASC` means every worker pulls priority-0 jobs first. New incoming mail keeps jumping the backfill.

## Safety checks

- Gmail rate limits: 250 quota units/sec/user. A `messages.get` is 5 units → 50 calls/sec/user ceiling. With ~64 concurrent slots (4×16), per-user throughput peaks around 30–40 calls/sec. Safely under quota; if 429s appear we dial concurrency back to 12.
- Supabase: writes are small (one delete or one update per job). No risk at this volume.
- DLQ: existing per-job try/catch + 25s timeout + reclaim of stuck "running" jobs all stay intact — no change to error handling.

## Files touched

- `src/lib/sync.server.ts` — bump `concurrency` default from 8 → 16
- One SQL call (not a migration) to `cron.alter_job` for `gmail-process-jobs-30s` so its command runs 4 parallel `net.http_post` calls instead of 1

## Out of scope

- No schema changes, no new tables, no UI changes, no priority-system changes. BackfillBanner just moves faster.

## If it's still slow after this

Most likely culprit would be Gmail 429s (visible in `pubsub_events` as `gmail_api_error`) — fix is dial concurrency back. Second most likely is Cloudflare CPU limit per invocation — fix is lower per-tick `limit` and fan out wider (e.g. 8 invocations × 50 jobs).
