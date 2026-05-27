## Diagnosis

Tony's account (`tpercoco@nucar.com`) is stuck in a Gmail-quota death spiral:

- `gmail_accounts.history_id` is frozen at `21468849` since 11:41 UTC.
- `last_push_at` is `NULL` (never been stamped successfully).
- Pub/Sub pushes ARE arriving (15+ in the last minute, `accounts_matched=1`) but every one returns `synced_count=0`.
- Worker logs show two repeating errors for his account:
  - `sync.label_added_handler_failed` — `Gmail API 403 ... Quota exceeded for quota metric 'Queries per minute per user'` on `messages/{id}?format=metadata`.
  - `sync.history_sync_transient_failed` — same 403 on `users/me/history?startHistoryId=21468849`.

Why it spirals: Tony has two Gmail labels linked to Zerrow folders (`Label_25 → Factory`, `Label_26 → Pulse`). His Gmail emits a large stream of `labelsAdded` events. In `syncSinceHistoryLocked` (`src/lib/sync.server.ts:921-937`), every matched `labelsAdded` event calls `getMessageMetadata` (one Gmail API call per event) just to feed `from/subject/snippet` into `recordManualMove`. With high event volume that burns the per-user-per-minute quota in seconds. Once exhausted, `listHistory` itself 403s, so the outer try returns early — `history_id` never advances and `last_push_at` is never stamped. The next push restarts from the same stale `startHistoryId`, replays the same backlog, and re-exhausts quota. Self-sustaining.

chris@nucar.com and chris@dagesse.com don't trip this because their `labelsAdded` volume is lower.

## Fix

### 1. Stop fetching Gmail metadata per labelsAdded event — `src/lib/sync.server.ts` (~lines 921-937)

In the labelsAdded loop, replace the per-event `getMessageMetadata(...)` call with a local-only lookup:

- If a row for `ev.message.id` already exists in `public.emails` for this account, read `from_addr`, `subject`, `snippet` from that row and pass it into `recordManualMove`.
- If the row doesn't exist locally yet, **skip** the `recordManualMove` for this event. The message is still being ingested through the normal pipeline (via `seenAdded` + `enqueueMessageJobs`); `process-message` will set the folder and seed `folder_examples` correctly when the row is created.

Net effect: zero Gmail calls inside the labelsAdded loop. That removes the quota pressure that's currently breaking Tony.

### 2. Advance `history_id` incrementally — `src/lib/sync.server.ts` (~lines 911-947, 989)

Today `bumpHistoryAndWatch(lastHistoryId)` is only called after every page succeeds. Change the walk to bump `history_id` AFTER each successful page (`if (hist.historyId) await bumpHistoryAndWatch(accountId, hist.historyId);`). Then if a later page 403s, the next push restarts from the page we already drained instead of replaying from `21468849`. Keep the outer post-loop bump as-is (idempotent via `bump_history_id_if_greater`).

### 3. One-off data repair for Tony

After the code change ships, fast-forward Tony's stuck cursor so he doesn't have to wait for the spiral to organically break. Set `gmail_accounts.history_id = '21479322'` (the most recent push payload's historyId) for account `e4af232e-2676-4f7c-9cb8-cb0f090daba8`. This skips the giant backlog; any messages newer than that will arrive via the next push, and his reconcile cron will catch anything in the gap within 5 minutes.

## Out of scope

- No changes to the poll cron, reconciler, or Pub/Sub envelope handling.
- No changes to `recordManualMove` itself — it stays a generic "promote + seed example" helper, just called with locally-sourced fields.
- No new quota-aware backoff layer (the metadata-fetch removal eliminates the root cause; we can revisit dedicated 429 backoff later if quota errors reappear on healthy accounts).