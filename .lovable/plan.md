# Make background mail processing faster

Goal: drain backlogs faster **and** lower per-email latency. You chose "speed first," so these changes trade some extra AI/compute usage for throughput.

## Where the time goes today

- **Live lane** (`gmail-process-live-5s`): every 5s, a single request, `limit=50`, worker concurrency **16**. Live mail runs **one AI classification per email inline** — a 4-model cascade with a 7s/attempt, 18s total budget. That cascade is the dominant cost.
- **Mixed lane** (`gmail-process-jobs-30s`): 4 parallel requests, `limit=100`, every 30s.
- **Webhook** drain on push: `runMessageJobs(25, 16)` with a 4s inline budget.
- Backfill already batches AI 8-per-call; live mail does not.

## Changes

### 1. Pump more work per tick (throughput)
- Raise worker concurrency from **16 → 32** for the job runners (`runMessageJobs` default + the values passed in `gmail-process-jobs.ts` and the webhook handler).
- Live lane (`gmail-process-live-5s`): bump `limit` from 50 → **100** and fan out from **1 → 3** parallel POSTs per 5s tick (matching the mixed-lane pattern). This roughly triples live drain capacity.
- Mixed lane (`gmail-process-jobs-30s`): keep 4 POSTs but they now run at concurrency 32.

### 2. Speed up the live AI cascade (latency)
In `src/lib/sync/config.ts` / `src/lib/ai.server.ts`:
- Drop `AI_CLASSIFY_ATTEMPT_TIMEOUT_MS` from **7s → 5s** so a slow model attempt fails over to the next one faster.
- Reorder/trim the `classifyEmail` cascade so the fast path wins first (lead with `gemini-2.5-flash-lite`, fall back to `flash`), cutting tail latency on the common case. Keep the same total-budget guard.

### 3. Batch the live AI lane under burst (backlog throughput)
- When the live runner claims a batch with many AI-eligible messages, route the AI step through the existing **batched** classifier (`classifyEmailsBatch`, 8/call) — the same second-pass path backfill uses — instead of N sequential single calls. Small messages still classify inline by rules (fast, instant folder); only the AI-fallback ones get batched. Net: large bursts drain in a fraction of the LLM round-trips while single new emails keep their inline, instant-folder behavior.

### 4. More aggressive webhook drain (push → visible latency)
- Raise `WEBHOOK_INLINE_DRAIN_BUDGET_MS` from **4s → 7s** and the webhook's inline `runMessageJobs` limit/concurrency, so a freshly-pushed email is far more likely to be fully filed before the ack returns (still safely under Pub/Sub's ~10s redelivery window).

## Technical notes
- Cron schedule changes (live-lane fan-out, limits) are applied as `cron.schedule(...)` SQL via the DB tooling, not a code migration — these are operator settings, consistent with how the crons are currently defined (`private.cron_post`).
- Concurrency 32 with Gmail fetch + AI per message stays within Cloudflare Worker subrequest limits for a `limit=100` batch.
- Rate-limit safety: if the AI gateway starts returning 429s under the higher concurrency, the existing backoff/retry path absorbs it; we can dial concurrency back to 24 if needed.
- No schema changes; no change to the durable `message_jobs` queue semantics (still `claim_message_jobs` SKIP LOCKED + 60s lease).

## Files touched
- `src/lib/sync/config.ts` — timeout/budget/concurrency constants
- `src/lib/sync/queue.ts` (`runMessageJobs` default concurrency + live batched-AI path)
- `src/routes/api/public/gmail-process-jobs.ts` — concurrency
- `src/routes/api/public/gmail-webhook.ts` — drain limit/concurrency/budget
- `src/lib/ai.server.ts` — cascade order/timeouts
- Cron jobs `gmail-process-live-5s` / `gmail-process-jobs-30s` (SQL, applied at build time)

## Verify
- Run the live + mixed job endpoints directly and confirm higher `processed` counts per call with no new error/DLQ spike.
- Watch `pubsub_events` for `gmail_api_error` 429s after rollout; confirm push → visible latency drops in the latency stats.
