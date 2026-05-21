# Plan: eliminate Gmail processing delays

## What the evidence shows

The issue was not that Pub/Sub was completely down. Gmail push events were arriving, but processing was delayed/hung:

- Gmail push events were arriving around the time of the email.
- The email itself arrived in Gmail at `19:05:28` but only appeared in Zerrow around `19:11:04`.
- The fallback poll job has not recorded a successful `poll` event since `01:02 UTC`, so if inline push processing stalls, there is no reliable 2-minute safety net.
- The webhook currently tries to both sync Gmail history and drain up to 100 message jobs inside the same push request. During bursts or slow Gmail/AI calls, that can cause the request to spend too long doing work and make activity look stale.

## Fix 1: make the Gmail push webhook fast and non-blocking

Change `/api/public/gmail-webhook` so it only does the minimum work needed when Gmail pushes:

1. Verify and decode the push payload.
2. Find the matching Gmail account.
3. Run `syncSinceHistory` to enqueue message jobs.
4. Return quickly.

Instead of draining the whole queue inline, it will only run a very small immediate drain for newly enqueued jobs, capped at a low number, so the UI can still feel realtime without letting a webhook request become a long-running worker.

This prevents one Gmail burst or slow message from making the whole push path look hung.

## Fix 2: make the background worker the primary processor

The durable `message_jobs` queue already exists. We should rely on it more heavily:

- `/api/public/gmail-process-jobs?limit=50` should run frequently and drain queued message jobs.
- `/api/public/gmail-poll` should keep acting as the safety net for missed push events.
- The worker already reclaims stuck `running` jobs after timeout; keep that behavior.

## Fix 3: repair cron authentication so fallback polling actually runs

The scheduled cron jobs currently depend on a Vault-based helper that was never populated, so the scheduled calls are not reliably authenticating.

I’ll replace that schedule with the standard Lovable Cloud scheduled-route pattern:

- Scheduled requests send the public `apikey` header.
- The existing cron endpoints accept either:
  - the existing `Authorization: Bearer CRON_SECRET`, or
  - the `apikey` header.
- Recreate the two schedules:
  - process jobs every minute, or fastest supported interval in the current database scheduler
  - poll Gmail every 2 minutes

This removes the manual Vault step and makes cron survive republish/remix better.

## Fix 4: improve Gmail activity visibility for delays

Update the Gmail sync activity panel so this exact failure mode is obvious:

- Show “push received but processing delayed” when pushes are arriving but jobs are pending/running.
- Show last successful poll time and warn if polling has not run recently.
- Keep the existing “Run worker now” action for stuck jobs.

## Verification

After implementation:

1. Confirm recent `poll` events resume.
2. Confirm `message_jobs` stays near zero after new mail arrives.
3. Confirm a test email creates a push event quickly and appears in Zerrow without a multi-minute stall.
4. Confirm the activity panel reports whether the delay is push, poll, or processing queue related.

## Files expected to change

- `src/routes/api/public/gmail-webhook.ts`
- `src/routes/api/public/gmail-process-jobs.ts`
- `src/routes/api/public/gmail-poll.ts`
- `src/lib/cron-auth.server.ts`
- `src/components/settings/PubsubActivity.tsx`
- New database migration to replace the Gmail cron schedules
