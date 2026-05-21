# Deep backfill in the background, with progress UI

Today the only backfill options are "recent 30" and "last 7 days," both run inline in a single HTTP call. For a 6‑month / "everything" pull this would time out and there's no way to surface progress. The fix uses the queue and cron worker that already power per‑message processing.

## What the user will see

1. On first sign‑up (and via a new **"Pull last 6 months"** button in Settings → Accounts), Zerrow kicks off a deep backfill.
2. A persistent banner appears at the top of Inbox / Folders:
   > "Importing your last 6 months of email — 1,240 of 8,500 done. You can keep using Zerrow; new emails will keep coming in live."
3. Banner auto‑dismisses when the job finishes (or shows "Finished — 8,500 imported" briefly).
4. User can cancel from Settings.

## How it works

```text
sign-up / button
      │
      ▼
startDeepBackfill (server fn)
  • create backfill_jobs row (status=listing)
  • return immediately
      │
      ▼
cron: /api/public/gmail-backfill-tick  (every 30s)
  • pick oldest active job
  • LIST phase: page Gmail search ~10 pages/tick,
                enqueue new IDs into message_jobs,
                save next_page_token + counts
  • when no next_page_token → status=processing
  • PROCESSING phase: count remaining message_jobs
                       for this account; when 0 → status=done
      │
      ▼
existing /api/public/gmail-process-jobs cron
  drains message_jobs as it already does
```

The actual message fetch/classify path is unchanged — we just feed the existing queue from a much larger ID list, paginated across cron ticks so no single request runs long.

## Changes

### 1. New table `backfill_jobs` (migration)
Columns: `id`, `user_id`, `gmail_account_id`, `query` (e.g. `newer_than:180d -in:chats -in:trash -in:spam`), `status` (`listing` | `processing` | `done` | `canceled` | `error`), `next_page_token`, `total_found`, `total_enqueued`, `already_had`, `started_at`, `updated_at`, `finished_at`, `last_error`. RLS: users access own rows.

### 2. Server logic (`src/lib/sync.server.ts`)
- `startBackfillJob(accountId, userId, { months })` — inserts a `backfill_jobs` row (one active per account; if one is already running for that account, return it instead of creating a duplicate).
- `tickBackfillJob(jobId)` — does one cron slice:
  - LIST: page `listMessages` up to ~10 pages (1k IDs), dedupe vs `emails` table, `enqueueMessageJob` for the rest, persist `next_page_token` + counts.
  - PROCESSING: query `message_jobs` count for this account; when 0 and listing complete → mark `done`.
- `cancelBackfillJob(jobId)` — sets status `canceled`; worker stops picking it up. Leaves already‑enqueued jobs to drain (they're cheap and valuable).

### 3. Server functions (`src/lib/gmail.functions.ts`)
- `startDeepBackfill({ account_id, months })` (1‑12, default 6) — auth‑gated, calls `startBackfillJob`.
- `getBackfillStatus({ account_id })` — returns the active/most‑recent job for the banner.
- `cancelDeepBackfill({ job_id })`.

### 4. Auto‑start on sign‑up
In `connectGmailFromSession` (the path `login.tsx` already calls), after the account row is saved and watch is set, call `startBackfillJob(account.id, userId, { months: 6 })`. Idempotent — re‑login won't spawn duplicates.

### 5. New cron route `/api/public/gmail-backfill-tick`
- Auth: same `isAuthorizedCron` pattern used by `gmail-process-jobs`.
- Picks the oldest active `backfill_jobs` row (or up to N) and calls `tickBackfillJob`. Schedule via pg_cron every 30s.

### 6. UI
- **`src/components/inbox/BackfillBanner.tsx`** (new): polls `getBackfillStatus` every 5s while active; shows progress as `total_enqueued − remaining_jobs / total_enqueued`. Mounted in `_authenticated.tsx` so it appears across Inbox/Folders/Settings.
- **Settings → Accounts**: add a **"Pull last 6 months"** button next to "Catch up last 7 days," plus a "Cancel import" button while a job is active. Show last completed import timestamp.

### 7. Telemetry
Log start/finish + per‑tick counts to `pubsub_events` (reusing the existing activity feed in Settings → Activity) so issues are debuggable from the UI.

## Out of scope
- No change to per‑message classification, filters, or webhook path.
- No change to existing "Backfill recent 30" or "Catch up last 7 days" buttons — they stay for quick fixes.
- "All time" is allowed (months=120 in the input range) but defaulted off; UI exposes 6 months.

## Verification
1. Click "Pull last 6 months" on a test account → banner appears within seconds with `total_found` climbing as LIST ticks run; `total_enqueued` grows; `message_jobs` worker drains them; banner shows decreasing remaining; banner clears when done.
2. Reload page mid‑import → banner reappears from server state.
3. Click Cancel → status flips to `canceled`, banner disappears; already‑pulled emails stay.
4. New sign‑up → backfill starts automatically without blocking the redirect to /inbox.

Approve to implement.
