# Bulletproof Gmail Processing

## What's actually broken

I checked the database for your account (`chris@nucar.com`):

- **`pubsub_events` table has 0 rows ever.** Google is not delivering a single push to `/api/public/gmail-webhook`. Every email you've received has only arrived through the 2-minute fallback poll. That's why things feel slow / occasionally missed.
- **Julie Caltabiano's email IS in your DB** — it was processed, classified to Factory, and archived 5/20 at 1:48 PM. The reason it looks "unprocessed" is that you moved it back into the Gmail Inbox afterwards, and we haven't re-synced that label change yet. Its stored `raw_labels` are `Label_347, CATEGORY_PERSONAL, Label_...` — no `INBOX`, no `UNREAD`.
- **There is no per-message retry.** If `processGmailMessage` throws for any reason (Gmail 5xx, AI timeout, classifier error), the message is silently skipped and never retried — the history cursor still advances.
- **Reconciliation only looks at the last 200 archived rows.** A move-back-to-inbox older than that is invisible until you click "Resync" manually.

## Plan

### 1. Durable per-message processing queue

Today: webhook/poll → `syncSinceHistory` → inline `processGmailMessage` for each new message. One failure = one lost message.

Change to a queue:

```text
history event ──► enqueue message_jobs(message_id, account_id, attempt=0)
                                 │
                                 ▼
                  process-message-jobs cron (every 30s)
                  ├─ claim batch (FOR UPDATE SKIP LOCKED)
                  ├─ run full pipeline (fetch → parse → classify → store)
                  ├─ success → delete row
                  └─ failure → attempt++, next_run_at = now()+backoff
                              attempt ≥ 5 → status='dlq', error stored
```

New table `message_jobs(id, gmail_account_id, gmail_message_id, attempt, next_run_at, status, last_error, created_at)` with a unique index on `(gmail_account_id, gmail_message_id)` so we never double-queue.

`syncSinceHistory` becomes a thin "enqueue" function. The webhook returns 200 immediately after enqueuing — no more long-running work inside the Pub/Sub push handler (which is what makes Pub/Sub retry storms and silently fail).

### 2. Faster, complete inbox reconciliation

- Bump the archived-rows scan from 200 → 1000 and run it every cron tick.
- Add a "full reconcile" button in Settings that walks all rows for the account, in pages of 500, and queues any label drift into `message_jobs`.
- Keep the per-message "Resync from Gmail" button on `EmailDetail` for one-offs.

### 3. Pub/Sub health & self-healing

The push subscription is broken right now. We need to know that without me running SQL.

- Add a `pubsub_health` view: last push received, last watch renew, accounts with active `watch_expiration`, push silence > 1h.
- Settings → Pub/Sub Activity card surfaces a red banner when silence > 1h AND watch is active, with two buttons:
  - **Re-arm watch** (calls existing `renewGmailWatch`)
  - **Send test push to webhook** (POSTs an empty Pub/Sub envelope and confirms it writes a `push_empty` row — isolates GCP-side vs. our-side)
- Add a server-side guard: if `gmail-poll` runs and notices `pubsub_events` has been silent > 6h while watch is active, it auto-calls `ensureWatch` to re-arm.

### 4. Per-message visibility in Settings

New "Processing jobs" panel below Pub/Sub Activity:

- Live count of `message_jobs` by status (pending, retrying, dlq)
- Table of DLQ rows with: from, subject, attempt count, last error, "Retry now" button
- Filter by account

This is the missing piece — today there's nowhere to see "we tried to process X and it failed because Y."

### 5. Idempotency hardening

- `processGmailMessage` already upserts by `(gmail_account_id, gmail_message_id)` — confirm and add a unique constraint if missing so retries are always safe.
- Webhook handler stays at "ack within 1s" so Pub/Sub never retries us (we own retries via `message_jobs`).

## Technical details

**Files touched:**

- New migration: `message_jobs` table + index, optional `emails` unique constraint
- `src/lib/sync.server.ts` — `syncSinceHistory` enqueues into `message_jobs` instead of processing inline; add `runMessageJobs(limit)` worker function; expand `reconcileLocalInbox` archived scan to 1000
- `src/routes/api/public/gmail-process-jobs.ts` — new cron endpoint, called every 30s
- `src/routes/api/public/gmail-webhook.ts` — return 200 after enqueue; never run pipeline inline
- `src/routes/api/public/gmail-poll.ts` — add self-heal: re-arm watch if push silent > 6h
- `src/lib/gmail.functions.ts` — add `listMessageJobs`, `retryMessageJob`, `runFullReconcile`, `pingWebhook` server fns
- `src/components/settings/PubsubActivity.tsx` — silence banner + test-push button
- `src/components/settings/ProcessingJobs.tsx` — new panel for DLQ visibility
- `src/routes/_authenticated/settings.tsx` — mount the new panel

**Cron schedule (Supabase pg_cron):**

- `gmail-process-jobs` every 30s (new — the actual worker)
- `gmail-poll` every 2 min (unchanged — fills history gaps)
- `gmail-renew-watches` daily (unchanged)

**No changes to:** classification logic, folder rules, saved instructions, AI prompts, or any UI outside Settings + EmailDetail.

## Out of scope

- Fixing the GCP Pub/Sub subscription itself (that's a one-time console action — I'll surface it as a clearly-marked banner with instructions, but I can't reach into your Google Cloud project)
- Rewriting the classifier
- Schema changes to `emails` beyond the unique constraint

After this lands: a message that arrives via push OR poll is enqueued in `message_jobs`, processed within 30s, retried with backoff on any failure, and visible in Settings with a "Retry" button if it ever ends up in DLQ. No message can silently disappear.
