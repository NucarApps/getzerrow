## Problem

When you record a meeting, the app creates the Recall bot and saves the row as `joining`. After that, the status is only ever advanced by:

1. The **Recall webhook** (`/api/public/recall-webhook`), or
2. A **reconcile cron** that polls Recall for non-terminal meetings.

The reconcile cron was never actually scheduled, and the webhook only fires against the published site once Recall is fully configured — so in your session the bot joined and started recording, but nothing wrote the new status back. The UI polls the DB every 10s and just keeps seeing `joining`.

## Fix

Give the app three independent ways to move the status forward, so it never gets stuck:

### 1. On-demand sync from the app (works immediately, no publish needed)
Add an authenticated `syncMeeting` server function that:
- Confirms the meeting belongs to the signed-in user (RLS).
- Pulls the live bot state from Recall and writes back status, recording URL, transcript, and summary (reusing the existing `syncMeetingFromRecall` logic).

Wire it into the Meetings UI:
- **Auto-sync** when the detail dialog opens for a non-terminal meeting, and on each poll tick while it's still `joining`/`recording`.
- A visible **"Refresh status"** button in the detail view for a manual pull.
- Also trigger a light sync for any non-terminal rows when the meetings list loads, so the list badge updates without opening each one.

### 2. Background reconcile cron (automatic, once published)
Schedule the existing `reconcile-meetings` endpoint to run every minute via `pg_cron`, using the project's standard `private.cron_post(...)` helper (same pattern as the other crons). This keeps statuses, recordings, transcripts, and summaries current even when nobody has the meeting open — the webhook fallback the code was already written for.

### 3. Keep the webhook as the fast path
No code change needed — once the reconcile cron and on-demand sync are in place, the webhook simply makes updates near-instant. The other two guarantee correctness if a webhook is ever missed or not yet configured.

## Technical details

- `src/lib/meetings.functions.ts`: add `syncMeeting({ id })` with `requireSupabaseAuth`. In the handler, verify ownership via the RLS client, then `const { syncMeetingFromRecall } = await import("./meetings.server")` (dynamic import so the service-role module never leaks into the client bundle) and run it for that row. Return the resolved status.
- `src/routes/_authenticated/meetings.tsx`: call `syncMeeting` via `useServerFn` — on detail open + inside the existing `refetchInterval` for non-terminal statuses, add a "Refresh status" button (with a spinner + toast), and fire a best-effort sync for non-terminal rows after the list query resolves. Invalidate the `["meeting", id]` / `["meetings"]` queries after a sync.
- New migration: `DO $$ ... cron.unschedule('reconcile-meetings-1m') ... $$;` then `cron.schedule('reconcile-meetings-1m', '* * * * *', $$ SELECT private.cron_post('/api/public/hooks/reconcile-meetings'); $$);` — mirroring the existing scheduled hooks. No table/schema changes.

No changes to the recording pipeline, Recall client, or webhook handler.
