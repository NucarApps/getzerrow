## Goal
Make the Inbox update as soon as Gmail Pub/Sub push events arrive, instead of waiting for the polling/job worker cycle.

## What I found
- Pub/Sub is now arriving correctly: recent `push` rows show `accounts_matched = 1` and `synced_count = 1`.
- The Inbox already has a realtime subscription to the `emails` table, and the table is in the realtime publication.
- The missing link is the processing path: the webhook currently enqueues Gmail message jobs, but those jobs are only drained by `/api/public/gmail-process-jobs` or the poll fallback. Until a job writes to `emails`, the Inbox realtime subscription has nothing to receive.
- The queue is currently empty, which means jobs do run eventually, but not directly from the push request.

## Plan
1. Update the Gmail webhook so after `syncSinceHistory()` enqueues messages from a push, it immediately drains a small batch of due `message_jobs` for that matched account.
2. Keep the existing queue/cron/poll fallback intact so slow Gmail/API/AI work can still retry safely if immediate processing times out or fails.
3. Add clearer Pub/Sub activity diagnostics: show both “queued from push” and “processed immediately” so we can distinguish delivery from inbox insertion.
4. Tighten the existing inbox realtime hook if needed so it refetches the exact active email/count queries after inserts/updates.

## Expected result
When a new Gmail push comes in, the webhook should enqueue the changed message, process it right away, insert/update `emails`, and the open Inbox should refresh from its realtime invalidation within a few seconds.