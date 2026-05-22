
# Make email processing fast and reliable

## Where we are right now

- Queue: **529 live** (priority 0) + **22,529 backfill** (priority 10) pending.
- Worker: 4 parallel `runMessageJobs(limit=100, concurrency=16)` calls every 30s.
- Real-world throughput is well below the theoretical ceiling because each individual job re-does work that should be shared, and live mail is stuck behind the same Worker invocations that are busy draining the backfill.

## Where the time actually goes (per message)

For a single message the worker does, in order:

1. Claim job (UPDATE)
2. Gmail `messages.get` (~150–400 ms)
3. `SELECT` existing email row (dedupe)
4. `INSERT` email row
5. **3 separate `SELECT`s** for folders / filters / overrides — *re-run for every job*
6. **`SELECT` folder_examples** — *re-run for every job*
7. **AI classify call** to Gemini (~800–2500 ms) — *the dominant cost*
8. `UPDATE` email row with classification
9. Optional Gmail `modify` (label/archive/read)
10. `DELETE` job row

Steps 5–7 are where most of the wall time goes, and they're paid once *per message* even though 100 messages in a batch share the same folder/filter/override config and could share an AI call.

## The plan

### 1. Hoist per-batch context out of the per-job loop (biggest single win, no API cost)

In `runMessageJobs`, fetch folders + folder_filters + inbox_overrides + folder_examples **once at the top of the batch**, keyed by `gmail_account_id`, and pass them into `processGmailMessage` / `classifyParsedEmail`. Today a 100-job batch issues ~400 extra Supabase round-trips it doesn't need.

Expected: ~30–40% latency cut per job, no behaviour change.

### 2. Dedicated live lane so new mail never waits behind the backfill

Add a second cron `gmail-process-live-5s` that calls `gmail-process-jobs?limit=25&priority=0` every 5 seconds. The endpoint takes a new `priority` filter and `runMessageJobs` honours it (`WHERE priority = 0`). The existing 30s × 4 fan-out keeps draining everything (live + backfill) as today.

Effect: a freshly received email is picked up within ~5s instead of up to 30s, even when 22k backfill jobs are queued.

### 3. Batch AI classification for the backfill (3–5× backfill throughput)

`classifyEmail` currently makes one Gemini call per email. For backfill jobs (priority ≥ 10) we group up to **8 emails per call** and ask Gemini to return an array of `{folder_name, confidence, summary, reason}`. Same prompt structure, same schema, just an array. One LLM round-trip serves 8 messages, so per-message classification cost drops from ~1.5s to ~0.25s.

Live mail (priority 0) keeps the single-message path so first email after a push is still classified in one shot.

### 4. Atomic claim using `SELECT … FOR UPDATE SKIP LOCKED`

Replace the current "SELECT 100 candidates then UPDATE each row one-by-one" pattern with a Postgres function `claim_message_jobs(p_limit int, p_priority int default null)` that does the select + lock + update in a single round-trip and returns the claimed rows. This kills the cross-invocation contention where four parallel workers race to claim the same rows and most of them lose.

Effect: cleaner code, no more "claim races", another ~10–15% throughput.

### 5. Tighten the Gmail fetch path

- Use the lighter `messages.get?format=metadata` for the dedupe-check fast path (current code calls full `format=full` even when the row already exists and only needs `raw_labels` to decide whether to repair).
- Drop the per-job pre-`SELECT` for dedupe and rely on the existing unique `(gmail_account_id, gmail_message_id)` constraint with `INSERT … ON CONFLICT DO NOTHING`. Saves one round-trip on the common "new message" path.

### 6. Index pass

Confirm (and add if missing):
- `message_jobs (status, priority, next_run_at)` partial index `WHERE status <> 'dlq'` — drives the worker's main query.
- `message_jobs (status, locked_at)` for the stuck-job sweep.
- `emails (gmail_account_id, gmail_message_id)` unique — needed for step 5.

## Expected outcome

| | Today | After |
|---|---|---|
| New mail picked up after push | up to 30s | ~5s |
| Backfill throughput | ~400–600 jobs/min | ~2000–3000 jobs/min |
| 22k backfill drain | ~60–90 min | **~10–15 min** |
| Per-job DB round-trips | ~10 | ~4 |
| Per-job Gemini calls (backfill) | 1 | 1/8 |

## Files touched

- `src/lib/sync.server.ts` — hoist batch context, switch to RPC-based claim, INSERT…ON CONFLICT, batch AI for backfill.
- `src/lib/ai.server.ts` — add `classifyEmailsBatch(emails[], folders)`.
- `src/routes/api/public/gmail-process-jobs.ts` — accept optional `?priority=` filter.
- New migration:
  - `claim_message_jobs` RPC (`SELECT … FOR UPDATE SKIP LOCKED` + `UPDATE … RETURNING`).
  - Confirm / add the indexes above.
  - New cron `gmail-process-live-5s` hitting `?priority=0`.

## Out of scope

- No schema changes to `emails` or `folders`.
- No UI changes (BackfillBanner just moves faster).
- No change to manual-move learning, label sync, or DLQ behaviour.

## Risk and rollback

- Batch AI for backfill: if Gemini returns a malformed array we fall back to per-message classify for that batch. No data loss path.
- New RPC: simple SQL, easy to drop. The old "select-then-update" code stays as fallback in one PR cycle.
- Live cron at 5s adds ~12 extra Worker invocations/min, negligible.

## If still slow after this

Most likely remaining bottleneck is the **Lovable Cloud database instance size** under concurrent worker load. If `cloud_status` shows healthy but worker queries spike in latency during peak processing, the right move is to bump the Cloud instance size in Backend → Advanced settings.
