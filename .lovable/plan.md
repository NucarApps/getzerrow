## Diagnosis

I traced what's happening end-to-end against the live database and worker logs:

**Gmail push → DB: working.**
`pubsub_events` shows pushes arriving every few seconds for both accounts; `accounts_matched=1`, `synced_count` > 0, no errors. `gmail_accounts.last_push_at` is current. `message_jobs` queue is being drained continuously (cron `gmail-process-jobs?priority=0` hits every ~5s, all 200).

**Email rows are being inserted, but most are never finalized.** In the last 24h:

```text
classified_by  | count
---------------+------
 pending       |  64   ← stuck
 ai            |  23
 domain_rule   |   5
 filter        |   4
 global_exclude|   4
```

64 of the last 24h emails are frozen at `classified_by='pending'` with `folder_id=null`. That's the state `processGmailMessage` writes between the initial insert and the post-classify UPDATE.

**Root cause (worker logs):**

```text
classify text-json failed (google/gemini-2.5-flash-lite) ZodError
  path: ["reason"]  code: too_big  maximum: 200
classify text-json failed (google/gemini-2.5-flash) ZodError
  path: ["summary"] code: too_big  maximum: 140
classify structured failed (...) AI_NoObjectGeneratedError: response did not match schema
```

Gemini is returning `reason`/`summary` strings longer than our Zod schema's `.max(140)` / `.max(200)`. Every fallback model also fails the same way. `classifyEmail` keeps retrying through all models until it exceeds `JOB_TIMEOUT_MS = 25_000` in `runMessageJobs`' `Promise.race`. When the timeout fires:

1. `processGmailMessage` is aborted mid-flight — the row stays at `classified_by='pending'`.
2. `handleError` in `sync.server.ts` retries / DLQs the `message_jobs` row, but never goes back and fixes the email row.

So the email is visible in the inbox immediately (good — that's by design), but it never gets a folder, summary, or final classified state, and never triggers the realtime UPDATE the UI is waiting for. "Not showing updates" = the row stays pending forever and looks frozen.

**Realtime publication: healthy.** `supabase_realtime` includes `public.emails` (31 columns, body_text/body_html correctly excluded) and `public.folders`. `REPLICA IDENTITY FULL` is set. The frontend hook (`use-email-realtime.ts`) is wired correctly.

## Plan

### 1. Make the AI classifier tolerant of long outputs (primary fix)

In `src/lib/sync/classify.ts` / the Zod schema used by `classifyEmail` (likely `src/lib/ai.server.ts`):

- Change `summary: z.string().max(140)` → `z.string().max(140).catch((c) => c.input.slice(0, 140))` and same pattern for `reason: z.string().max(200)`.
- Equivalently: post-process the parsed result to truncate, instead of failing validation.
- Drop the JSON-text fallback parse-then-validate path's hard reject for the same two fields.

Effect: Gemini's verbose output is accepted (truncated) instead of throwing through every fallback model and burning the 25s budget.

### 2. Guarantee `pending` is never the terminal state

In `src/lib/sync.server.ts` `processOne` (the `Promise.race` catch path) and `handleError`: when a job times out or DLQs, also write `classified_by='ai_error'` + `classification_reason='job timeout/DLQ'` onto the corresponding `emails` row (looked up by `gmail_account_id` + `gmail_message_id`). This guarantees the row gets one final UPDATE that the realtime channel will broadcast, and the UI stops looking stuck.

### 3. Backfill the 64 stuck rows

One-shot SQL: requeue every `emails` row with `classified_by='pending'` from the last 7 days by inserting fresh `message_jobs` rows (priority=0) and clearing `processed_at`. After fix #1 lands they'll classify on the next cron tick.

### 4. Verify

- Watch worker logs for `classify text-json failed` — should stop.
- `SELECT classified_by, count(*) FROM emails WHERE created_at > now() - interval '1 hour' GROUP BY 1` should show no `pending` after one cron cycle.
- In the live UI, send a test email to the connected mailbox; confirm it appears within a few seconds and then transitions from pending → ai/folder-assigned via realtime (no manual refresh).

## Files to change

- `src/lib/ai.server.ts` (or wherever the classify Zod schema lives) — relax `summary`/`reason` validators.
- `src/lib/sync.server.ts` — finalize email row on timeout/DLQ.
- One-shot backfill via the migration/insert tool — requeue 64 stuck rows.

No frontend changes needed; the realtime path is already correct.
