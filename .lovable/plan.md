# Auto-classification: cron poll fallback

## Current state (already working)
- Gmail → Pub/Sub topic `gmail-push` → `POST /api/public/gmail-webhook`
- Webhook calls `syncSinceHistory(accountId)`, which pulls new messages and runs `processGmailMessage` on each
- `processGmailMessage` classifies via (1) linked Gmail label, (2) folder filters, (3) AI (`classifyEmail` via Lovable AI Gateway), then inserts into `emails` with `folder_id`, `ai_summary`, `ai_confidence`, applying `auto_archive` / `auto_mark_read` if set

So real-time auto-classification is already in place. This plan only adds the safety net.

## What I'll add

A scheduled `pg_cron` job that POSTs to the existing `/api/public/gmail-poll` route every 2 minutes. That route already loops over every `gmail_account` and runs `syncSinceHistory`, so any message a Pub/Sub push missed gets picked up and classified within ~2 minutes.

## Steps

1. Enable `pg_cron` and `pg_net` extensions (no-op if already enabled).
2. Schedule the job via `cron.schedule` using `net.http_post`:
   - Name: `gmail-poll-fallback`
   - Schedule: `*/2 * * * *` (every 2 minutes)
   - URL: `https://project--9ca78824-55f5-4897-b74d-b5b1d219918a.lovable.app/api/public/gmail-poll`
   - Headers: `Content-Type: application/json`, `apikey: <publishable key>`
   - Body: `{}` (route reads no body fields)
3. Insert via the Supabase insert tool (not migration), since the URL + anon key are environment-specific.

## Technical notes

- No code changes — the `/api/public/gmail-poll` route already exists and does exactly this work.
- `syncSinceHistory` is idempotent: it skips messages already in the `emails` table (uniqueness on `gmail_message_id` + `gmail_account_id`), so overlap with the webhook is harmless.
- If a push watch has expired, `syncSinceHistory` → `bumpHistoryAndWatch` renews it automatically on each poll, so the watch self-heals.
- To inspect: `SELECT * FROM cron.job;` and `SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;`
- To disable later: `SELECT cron.unschedule('gmail-poll-fallback');`
