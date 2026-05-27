## What's happening

When you click "Run now" on the Factory daily digest, the request goes through this path:

```
UI → runFolderSummaryNow (serverFn) → runFolderSummary
   → summarizeFolderEmails → Lovable AI (google/gemini-2.5-pro, structured output)
   → insertMessage (Gmail API)
```

The Factory folder has a heavy custom prompt (5 categorized sections, strict HTML rules) and up to 150 emails. Gemini 2.5 Pro with structured output on that input regularly takes longer than the Cloudflare Worker / AI Gateway request budget, so the gateway returns "upstream request timeout" before the model finishes. The session replay confirms two back-to-back timeout toasts at ~30s.

## Fix

Move "Run now" off the synchronous request path so the user click never has to wait on the model.

### 1. Background job for digest runs

- Add a `folder_summary_jobs` table: `id, schedule_id, user_id, status (pending|running|done|failed), error, created_at, started_at, finished_at, emails_count`.
- New serverFn `enqueueFolderSummaryRun({ id })` — inserts a `pending` job and returns the job id immediately.
- New serverFn `getFolderSummaryJob({ id })` — returns status for polling.
- Update `runNow` in `FolderEditor.tsx` to enqueue, then poll (every 2s, max ~5 min) and toast on completion/failure. Show "Generating digest…" while running.

### 2. Worker that actually runs `runFolderSummary`

- New public cron endpoint `src/routes/api/public/hooks/run-folder-summary-jobs.ts` (verifies `CRON_SECRET`).
- Claims one pending job at a time via a `claim_folder_summary_job` RPC (SKIP LOCKED, 5 min lease, mirrors the `claim_message_jobs` pattern).
- Calls existing `runFolderSummary(scheduleId)`, then marks the job done/failed and writes `emails_count` / `error`.
- Register in pg_cron to fire every minute (same secret as other cron hooks).

### 3. Make the model call more resilient

Inside `summarizeFolderEmails` (`src/lib/ai.server.ts`):

- Switch the primary model from `google/gemini-2.5-pro` to `google/gemini-3-flash-preview` (project default, much faster, still strong at structured output). Keep the structured-output schema.
- Keep the existing markdown fallback but also switch it to flash.
- Wrap the structured call in `Promise.race` with a 90s timeout that throws a clean "digest generation timed out" so the job fails fast instead of hanging on the lease.
- Pre-trim: cap emails to 100 (currently 150) and snippet to 200 chars when the folder prompt is long (>1.5k chars), to reduce token count for prompt-heavy folders like Factory.

### 4. Existing scheduled runs

`run-folder-summaries.ts` cron currently calls `runFolderSummary` inline. Change it to enqueue jobs into the same `folder_summary_jobs` table so scheduled runs benefit from the same background worker and don't tie up the cron tick.

### 5. Recovery for the Factory schedule

After deploy, the next click on "Run now" will enqueue + poll instead of timing out. No data fix needed — the previous failed attempts already wrote `last_error` and advanced `next_run_at`.

## Files touched

- New migration: `folder_summary_jobs` table + grants + RLS + `claim_folder_summary_job` RPC, plus pg_cron schedule.
- New: `src/routes/api/public/hooks/run-folder-summary-jobs.ts`
- Edit: `src/lib/summaries.server.ts` (job helpers, no logic change to `runFolderSummary` itself beyond return shape)
- Edit: `src/lib/gmail.functions.ts` (add `enqueueFolderSummaryRun`, `getFolderSummaryJob`; keep `runFolderSummaryNow` as a thin wrapper around enqueue for back-compat)
- Edit: `src/lib/ai.server.ts` (flash model, 90s race, prompt-aware trimming)
- Edit: `src/components/folders/FolderEditor.tsx` (enqueue + poll UX in `runNow`)
- Edit: `src/routes/api/public/hooks/run-folder-summaries.ts` (enqueue instead of inline run)

## Out of scope

- No changes to filter/classify pipeline or inbox sync.
- No changes to the Factory folder's prompt or category rules.
