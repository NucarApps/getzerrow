
## What's happening

Michelle's email did arrive in the app — the 18:26 poll detected it and enqueued a job for Gmail message `19e469f81176c627`. But the job is stuck:

```
message_jobs row
  status        running
  locked_at     18:26:00   (held > 2 min, never released)
  attempt       0
  last_error    null
```

`processGmailMessage` calls Gmail `GetMessage` (the API you saw erroring in Google Console) and then `classifyParsedEmail` (AI Gateway). One of those is hanging or hitting the Cloudflare Worker wall-time limit, so the request is killed *before* the `catch` block runs. Because nothing increments `attempt` or clears `locked_at`, the row sits in `running` until the 5-minute lock cutoff — then the next poll reclaims it and the cycle repeats. The email never appears, and the job never reaches the DLQ.

This is also why we never see a `last_error` for it: the worker is dying mid-execution, not throwing.

## Plan

### 1. Unstick Michelle's email right now
- Reset that specific job (`status='pending'`, `locked_at=null`, `next_run_at=now()`) so the next poll picks it up cleanly. If it fails again, it'll do so loudly (see #2).

### 2. Insert the email row BEFORE classification (the real fix for visibility)
In `processGmailMessage`:
- After `parseMessage`, insert the email row immediately with `folder_id=null` (lands in Inbox), `classified_by='pending'`.
- Then run `classifyParsedEmail` and `UPDATE` the row with folder/summary/etc.
- If classification fails or times out, the email is already visible in the inbox — only the AI label is missing.

This is the core decoupling: Gmail-API latency and AI latency should never block an email from appearing.

### 3. Hard timeout + stuck-job self-heal in `runMessageJobs`
- Wrap `processGmailMessage` in `Promise.race` with a 25 s timeout so the worker always throws into the `catch` block (which already handles attempt counting, backoff, DLQ).
- At the top of `runMessageJobs`, sweep rows where `status='running' AND locked_at < cutoff`: increment `attempt`, set `last_error='stuck (worker timeout)'`, and either re-pend with backoff or move to DLQ at `MAX_JOB_ATTEMPTS`. This breaks the infinite stuck→reclaim loop even if a future bug brings it back.

### 4. Surface stuck jobs in the diagnostics panel
Add a small "Stuck jobs" row to `PubsubActivity` showing any `message_jobs` with `status='running'` for >2 min, with the gmail_message_id and a "Force retry" button (calls existing `retryMessageJob`). So next time this happens you see it instead of guessing.

## Files to touch
- `src/lib/sync.server.ts` — split insert/classify in `processGmailMessage`; add stuck-job sweep + `Promise.race` timeout in `runMessageJobs`.
- `src/lib/gmail.functions.ts` — extend `listPubsubEvents` to also return stuck `message_jobs`.
- `src/components/settings/PubsubActivity.tsx` — render stuck-jobs row + Force retry.
- One-off SQL to reset job `f6e18c37-…` to pending so Michelle's email shows up on the next poll (≤ 2 min).

## Out of scope
- Re-architecting Gmail polling, push, or watch logic.
- Changing the classifier itself.
- GCP console changes.
