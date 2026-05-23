## Email Pipeline — Audit & Tune-Up

I traced the full path: Gmail Pub/Sub push → webhook → `syncSinceHistory` (history API) → `enqueueMessageJob` → `message_jobs` table → `runMessageJobs` worker → `processGmailMessage` (filters → Gmail label → AI) → Gmail side-effects. Polling, backfill, and watch renewal back this up via pg_cron.

The architecture is solid (durable queue, priority lanes, retries with jitter, self-healing, watch re-arm, label echo suppression). But the live cron table has accumulated duplicates and a few correctness/quality bugs that are worth fixing.

### Findings

**1. Duplicate cron jobs (wasted load, double Gmail quota burn).** Querying `cron.job` shows:
```text
gmail-poll-2m              */2 * * * *
gmail-poll-fallback        */2 * * * *   ← duplicate of above
gmail-renew-watches        0 */6 * * *
gmail-renew-watches-daily  0 9 * * *     ← duplicate (6h cron already covers daily)
run-folder-summaries           */5 * * * *
run-folder-summaries-every-5min */5 * * * *  ← duplicate
gmail-process-jobs-30s     30s (4× parallel POSTs, limit=100 each)
gmail-process-live-5s      5s
gmail-backfill-tick        1m
```
Every 2 minutes we hit `/gmail-poll` twice — that's 2× the Gmail history calls per account and 2× the `pubsub_events` "poll" rows. Same for renewals and summaries.

**2. Hard-coded anon key + URL inside migration SQL.** `gmail-process-jobs-30s` and the duplicate jobs embed the full publishable key and `project--{id}.lovable.app` URL in `net.http_post`. Works, but if the project ID or anon key ever rotates, cron silently breaks. The other jobs use the `private.cron_post()` helper which reads from `private.cron_settings` — that's the pattern to standardize on.

**3. Webhook does heavy work inline.** `gmail-webhook` calls `syncSinceHistory` AND then `runMessageJobs(50, 16, {priority:0})` inside the same request. Pub/Sub expects fast 200s; a slow webhook causes Google to retry → duplicate sync work. The 5s `gmail-process-live-5s` cron already drains the priority-0 lane, so the inline drain is redundant and risks Worker CPU timeouts on bursts.

**4. `syncSinceHistory` rebootstrap loses messages.** When the Gmail History API returns "historyId too old", we `update gmail_accounts set history_id = null` and return `{error}`. The next sync calls `backfillRecent(accountId, 20)` which **processes inline** (not via the queue) and only covers `newer_than:7d` with `maxResults=20`. If a burst happened during the gap, only the most recent 20 messages from the past week are captured, and they're processed synchronously inside whatever request triggered the bootstrap (often the webhook).

**5. Backfill AI bypasses `min_ai_confidence`.** In `runMessageJobs`, the batched AI pass for backfill jobs (`pendingAi`) writes `folder_id: r?.folder_id` directly without checking each folder's `min_ai_confidence`. Live mail honors the threshold (`processGmailMessage` → `classifyParsedEmail`), but backfilled mail can land in a folder at, say, 40% confidence even if the user set min=80%. Also `classified_by: r?.folder_id ? "ai" : "ai"` is a dead ternary.

**6. `folder_filters` fetched globally.** `loadAccountContext` selects ALL `folder_filters` rows in the database, then filters in JS by `folderIds`. RLS doesn't apply (service role). Fine for now but scales poorly and risks cross-account leakage if a bug ever drops the JS filter.

**7. No automated `reconcileLocalInbox`.** The safety-net function exists but is never scheduled. If a history event is ever missed (e.g. during the rebootstrap window), the local inbox can drift from Gmail until the user manually triggers a sync.

**8. Webhook idempotency.** We don't dedupe by Pub/Sub `messageId`. `enqueueMessageJob` is upserted (safe), but `syncSinceHistory` re-runs end-to-end on Google's retry.

### Plan (in priority order)

**P0 — Clean up cron (migration):**
- `cron.unschedule('gmail-poll-fallback')`, `cron.unschedule('gmail-renew-watches-daily')`, `cron.unschedule('run-folder-summaries-every-5min')`.
- Rewrite `gmail-process-jobs-30s` to use `private.cron_post('/api/public/gmail-process-jobs?limit=100')` (4× in one command body, same as today, but no embedded keys).
- Verify final job table: 1× poll/2m, 1× process-jobs/30s, 1× process-live/5s, 1× backfill-tick/1m, 1× renew-watches/6h, 1× summaries/5m.

**P0 — Make webhook fast:**
- In `gmail-webhook.ts` POST handler: keep `syncSinceHistory` (it's the enqueue step), drop the inline `runMessageJobs(50, ..., {priority:0})`. The 5s live-lane cron already handles drainage, and the webhook stops blocking Pub/Sub.

**P1 — Fix rebootstrap (`sync.server.ts`):**
- When history is too old, enqueue via `backfillRecent` rewritten to `enqueueMessageJob` (priority 0) for the recent IDs instead of inline `processGmailMessage`. Bump `maxResults` to 100 and widen the window to `newer_than:30d` so a longer outage doesn't drop mail.

**P1 — Honor `min_ai_confidence` in batched backfill AI:**
- In `runMessageJobs`'s `pendingAi` loop, look up the candidate folder's `min_ai_confidence` from `ctx.folders`. If `r.confidence < threshold`, set `folder_id: null` and `classified_by: "ai_low_confidence"` (matches live behavior in `classifyParsedEmail`). Remove the `r?.folder_id ? "ai" : "ai"` dead ternary.

**P2 — Scope `folder_filters` query:**
- Change `loadAccountContext` to fetch `folder_filters` joined/filtered to the account's folder IDs (`in("folder_id", folderIds)`).

**P2 — Schedule `reconcileLocalInbox`:**
- New cron `gmail-reconcile` every 15 min calling a new `/api/public/gmail-reconcile` route that iterates accounts and runs `reconcileLocalInbox(accountId, 100)`. Logs to `pubsub_events` as `event_type='reconcile'`.

**P3 — Webhook dedupe (optional):**
- Skip processing if we've already logged a `pubsub_events` row with the same `message_id` within the last 60s. Cheap insurance against Pub/Sub redeliveries.

### Technical notes

- All P0/P1 changes are surgical: 1 SQL migration (cleanup) + edits to `src/routes/api/public/gmail-webhook.ts` and `src/lib/sync.server.ts`. No schema changes.
- P2 reconcile adds 1 new route file and 1 cron entry in the same migration as P0.
- I'll leave the existing retry/backoff/DLQ machinery untouched — it's well-tuned (30s/2m/10m/30m/2h, free retries for transient Gmail errors, 25s job timeout, 35s stuck-worker reclaim).
- After applying, I'll verify with `SELECT jobname, schedule FROM cron.job` and a manual webhook test, then watch `pubsub_events` and `message_jobs` for a few minutes.

Want me to proceed with P0+P1 only, or include P2 (reconcile cron + scoped filters) and P3 (webhook dedupe) in the same pass?
