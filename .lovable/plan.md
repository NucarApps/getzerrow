# Diagnose the Pub/Sub silence + fix the stale Julie Caltabiano row

## What's actually happening

1. **The Julie Caltabiano email IS processed.** It's in the DB:
   - From: `Julie.Caltabiano@nissan-usa.com`
   - Subject: "FW: INFORMATION: Voice of Customer Survey – Appeals & Post-Launch Q&A"
   - Classified to **Factory** via domain rule, auto-archived, marked read.
   - Stored labels: `Label_347, CATEGORY_PERSONAL, Factory` — no INBOX, no UNREAD.

2. **You moved it back to your inbox in Gmail.** Now Gmail says it has INBOX + UNREAD, but our row still shows the pre-move state. Our `applyLabelChange` handler would flip `is_archived=false` and `is_read=false` the moment we see a `labelsAdded` history event for INBOX/UNREAD — we just haven't seen it.

3. **Why we haven't seen it: Pub/Sub is dead silent.** `pubsub_events` has **zero rows in its entire history**. Google has never POSTed to `/api/public/gmail-webhook`. Everything currently working works only because of the 2-min fallback poll. That's the real bug.

## Plan

### Step 1 — Unstick the immediate Julie Caltabiano row (fast)
Add a small **"Resync this message from Gmail"** action in the email detail view. It calls a new `resyncMessage` server function that:
- Fetches the current Gmail message metadata (labels) via the existing `getMessageMetadata` helper.
- Calls `applyLabelChange` against the current labels vs. our stored `raw_labels` to reconcile INBOX/UNREAD/TRASH state immediately.
- Invalidates the inbox query.

This gives you a button you can hit on any row that looks stale, without waiting for the next poll.

### Step 2 — Make stale-archived rows reconcile automatically
`reconcileLocalInbox` today only checks rows where `is_archived = false`. So once we archive a row, we never re-check it — meaning "moved back to inbox in Gmail" is silently missed by reconciliation.

Change: run a second pass that scans the **most recent 200 archived rows** for each account and checks Gmail for INBOX/UNREAD label additions. Cheap (just label fetches, batched), runs in the same 2-min cron tick. This guarantees that anything moved back to inbox in Gmail shows up in our inbox within 2 minutes even when Pub/Sub is silent.

### Step 3 — Surface a Pub/Sub health banner in Settings
In the new "Gmail Pub/Sub activity" card, add a red banner at the top when:
- `pubsub_events` has zero rows in the last 24h, AND
- the account has an active `watch_expiration` in the future.

Banner text: "Gmail is not pushing notifications to this app. Emails are still arriving via the 2-minute fallback poll, but live updates are off. Click **Re-arm push watch** to refresh the Gmail watch."

The "Re-arm push watch" button calls the existing `renewGmailWatch` server fn (already wired in Settings) — that re-runs `users.watch` against the configured `GMAIL_PUBSUB_TOPIC`, which is the standard fix when a watch goes silent.

### Step 4 — Add a diagnostics panel to confirm topic config
Below the Pub/Sub activity card, add a small **"Push subscription diagnostics"** panel that shows:
- The configured topic name (`GMAIL_PUBSUB_TOPIC` env var, masked).
- Whether the env var is set at all.
- The account's current `watch_expiration` and `history_id`.
- A "Send test request to webhook" button that POSTs a synthetic empty Pub/Sub envelope to `/api/public/gmail-webhook` and confirms our handler responds 200 and writes a `push_empty` row. This proves the endpoint itself is reachable — if the test succeeds but real pushes are still missing, the problem is on the Google Cloud subscription side (subscription deleted, points to the wrong URL, or topic permissions stripped).

We cannot introspect the GCP push subscription from inside the app, but this gives you a clean test that isolates "our endpoint works" vs. "GCP isn't pushing."

## What this does NOT change
- No schema changes.
- No change to classification logic, folders, or auto-archive rules.
- No change to your saved instructions or digest config.
- No new secrets.

## Technical notes
Files touched:
- `src/lib/sync.server.ts` — extend `reconcileLocalInbox` to also scan recent archived rows.
- `src/lib/gmail.functions.ts` — new `resyncMessage` + `pingPubsubWebhook` server fns.
- `src/components/inbox/EmailDetail.tsx` (or equivalent) — "Resync from Gmail" button.
- `src/components/settings/PubsubActivity.tsx` — silent-pushes banner + diagnostics panel + ping button.

After this lands you'll have (a) an immediate way to fix the Julie row, (b) automatic reconciliation of emails moved back to inbox in Gmail within 2 minutes, and (c) a clear signal in Settings that Pub/Sub itself is silent, plus a test that tells you whether to re-arm the watch or fix the GCP subscription.
