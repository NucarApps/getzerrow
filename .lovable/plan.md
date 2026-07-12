# Instant mail, guaranteed — no refresh

## What I found (diagnosis)

The instant path already exists and works:

```text
Gmail  →  Pub/Sub push  →  /api/public/gmail-webhook
       →  syncSinceHistory (history diff → enqueue message_jobs)
       →  inline drain: getMessage → rules-classify → INSERT emails row  ← realtime fires here
       →  Postgres realtime → use-email-realtime.ts splices row into open inbox (no refetch)
       →  (AI classify runs AFTER the insert, only settles the folder)
```

Live telemetry (last 48h):
- **push → visible: p50 2.6s, p95 7.3s** — new mail appears within a few seconds, no refresh. The row is inserted *before* AI runs, so AI latency never blocks visibility.
- **push → ack: p50 4.1s, p95 8.7s** — dangerously close to Pub/Sub's ~10s redelivery cliff; 8 duplicate deliveries already recorded. Cause: the webhook holds the HTTP response open while it inline-drains *and runs AI* (up to 18s budget) before acking.
- Pub/Sub still authenticates via the legacy `?token=` secret (3,048 events), not OIDC.
- Two connected accounts are `needs_reconnect=true` (dead OAuth) → they receive **no pushes at all** until reconnected.

So it isn't broken — but three links can silently turn "instant" into "only after the 30s background sync / manual refresh." This plan fixes the latency risk and closes the silent-failure gaps.

## Weak links → fixes

### 1. Webhook acks too slowly (redelivery risk)

The inline drain runs the *full* per-message job, including inline AI classification, before returning `200`. The `emails` row is already visible after the insert (~1-2s in), so holding the ack for AI buys nothing for visibility and pushes p95 ack to 8.7s.

**Fix:** give the webhook drain an "insert-and-ack" mode that defers the AI step.
- Add an optional `deferAi` flag threaded from `runMessageJobs` → `processGmailMessage` (`src/lib/sync.server.ts`, `src/lib/sync/process-message.ts`). When set, rule-matched mail still lands final in one insert; AI-bound mail inserts as `pending_ai` and the function returns immediately **without** calling `classifyByAi`.
- The webhook (`src/routes/api/public/gmail-webhook.ts`) calls the drain with `deferAi: true`; the existing `gmail-process-live-5s` cron (already running every 5s, no deferAi) finishes the AI pass and fires the settling realtime UPDATE within ~5s.
- Lower `WEBHOOK_INLINE_DRAIN_BUDGET_MS` from 7s to ~3s (`src/lib/sync/config.ts`).

Result: push → ack drops to ~2-3s (well under the deadline, redeliveries stop); push → visible stays ~2.6s; AI settles the folder a few seconds later — the "appears instantly, then settles" behavior already accepted.

### 2. A stalled realtime socket only self-heals after 30s

`use-email-realtime.ts` already re-auths on token refresh, reconnects on `CHANNEL_ERROR/TIMED_OUT/CLOSED`, and catches up on tab-visibility. The gap: a socket that reports `SUBSCRIBED` but silently stops delivering (zombie websocket) is only rescued by the 30s background sync — new mail then waits up to 30s.

**Fix:** add a lightweight liveness watchdog in `src/lib/use-email-realtime.ts`.
- Track `lastRealtimeEventAt` (updated on every insert/update/delete) and the last SUBSCRIBED time.
- The inbox already runs a 30s background sync; when that sync pulls in `emails` rows **newer** than `lastRealtimeEventAt` (i.e. realtime missed them), force `teardown()` + `connect()` to rebuild the channel.
- Add a periodic 15s check: if `SUBSCRIBED` but no events for a while, send a channel presence/ping and reconnect on failure.

Result: a dead socket is detected and rebuilt in ~15s instead of silently degrading; combined with the existing background sync, the worst case is bounded and the common case stays instant.

### 3. A dead push channel is silent

Watch renewal is well covered (renew cron at :11/:41, opportunistic top-up on push, poll-2m silence re-arm). The remaining silent case is `needs_reconnect=true` — no push will ever arrive for that account, but the user may not notice.

**Fix:** verify `src/components/inbox/ReconnectBanner.tsx` renders whenever the selected account has `needs_reconnect=true`, with copy that explains instant delivery is paused until they reconnect. Wire it to the account list if not already surfaced. (Presentation-only; no pipeline change.)

## Verification

- Drive the preview with an authenticated session (Playwright), keep the inbox open, send a live test email to a connected account, and confirm the row appears with **no refresh**; capture a screenshot before/after.
- Re-run the push→ack and push→visible latency queries (`pubsub_events.latency_ms`, `emails.published_at_ms` vs `created_at`) and confirm ack p95 drops below ~4s and visible p50 stays ≈2.6s.
- Run existing unit tests (`realtime-belongs.test.ts`, sync tests) and add a test for the `deferAi` insert path and the watchdog reconnect trigger.
- Confirm the reconnect banner shows for a `needs_reconnect` account.

## Out of scope

- Migrating the Pub/Sub subscription from legacy `?token=` to OIDC (a Google-side subscription config change, not app code) — noted as a follow-up; the webhook already accepts OIDC bearer tokens.
- Changing the AI model, classification logic, or folder side-effects.
- Reconnecting the two dead-OAuth accounts (user action).

## Technical notes

- `deferAi` only skips the post-insert `classifyByAi` call in `process-message.ts`; the row insert, rules classification, and `pending_ai` marking are unchanged, so the server RPC gates (`get_emails_list_decrypted`, `get_folder_unread_counts`) and `matchesScope` already surface these rows correctly.
- The 5s live cron (`gmail-process-live-5s`) claims `priority=0` jobs via `claim_message_jobs` (FOR UPDATE SKIP LOCKED, 60s lease), so a webhook that acks before AI leaves the job safely claimable — no double-processing.
- Watchdog teardown/reconnect reuses the existing `teardown()`/`connect()` closures; no new channel-management surface.
