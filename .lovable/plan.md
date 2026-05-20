## Short answer

**Maybe — but not as much as you'd think.** Most `MailboxService.GetMessage` errors you see in GCP are transient (HTTP 429/500/503). Here's how they map to actual delays in your app:

| Where GetMessage is called | What happens on failure today | Delay impact |
|---|---|---|
| `runMessageJobs` worker (queue path — most messages) | Already retries with exponential backoff (30s → 2m → 10m → 30m → 2h); 5 fails → DLQ | Low — by design |
| `syncSinceHistory` inline during poll/push (line 758, 819) | Throws, whole poll cycle errors, retried in 2 min | Medium — one bad message kills a whole cycle |
| `reconcileLocalInbox` (line 854, 894) | Single row skipped, continues | Low |
| Folder backfill (line 1012) | Aborts that page | Medium for backfills |

Three real weaknesses worth fixing:

1. **No fetch timeout in `gmailFetch`.** A hung GetMessage call can stall the entire poll/worker batch indefinitely. The 5-minute job lock eventually frees it, but you lose minutes per stuck call.
2. **429 (rate limit) is treated like any failure** — it burns an attempt and applies long backoff, when it should use short jittered backoff and not count toward the DLQ limit.
3. **You can't see GetMessage error rate from the UI.** Sync activity shows poll runs but doesn't break out 5xx/429 vs other failures, so you have no way to correlate GCP console spikes with app delays.

## Plan

### 1. Add a request timeout + classify Gmail errors (`src/lib/gmail.server.ts`)

Update `gmailFetch` to:
- Use `AbortSignal.timeout(20_000)` so no single call hangs the worker.
- Throw a typed error including `status` (number) and `retryable` (boolean) so the worker can branch.
- Classify `429`, `500`, `502`, `503`, `504`, and abort/network errors as retryable; `400`, `401`, `403`, `404` as terminal.

### 2. Smarter worker retry policy (`src/lib/sync.server.ts` `runMessageJobs`)

- On retryable errors (429/5xx/timeout): use short jittered backoff (`30s + jitter`, `90s + jitter`, `5m`, `15m`, `1h`), AND don't increment `attempt` for the first 2 retryable failures — only count "real" failures toward DLQ.
- On terminal errors (400/403): go straight to DLQ instead of retrying 5 times.
- Keep the existing 404 → delete row behavior.

### 3. Surface Gmail-side errors in the Sync activity panel

- Extend `pubsub_events` logging in poll and worker to include an `error` row when a GetMessage call hits 429/5xx, so the panel's "Errors" tile reflects what you see in GCP.
- Add a small **"Gmail API errors (24h)"** tile next to the existing 6 tiles, counting events whose `error` field matches `Gmail API 4\d\d|5\d\d`.
- When that count is non-zero, show a neutral info banner: "Some Gmail GetMessage calls are failing on Google's side (429/503). The worker is retrying them — see the Processing queue panel for DLQ items."

### 4. Out of scope

- The actual GCP console errors. Those are on Google's side; we can only make our retry behavior bulletproof and the visibility better.
- Schema changes. `pubsub_events.error` is already free-form text.
- The classifier, folder rules, or processing logic.

### Files

- `src/lib/gmail.server.ts` — timeout + typed error class
- `src/lib/sync.server.ts` — branch on `error.retryable` in `runMessageJobs`; log a `pubsub_events` row when GetMessage fails inside `syncSinceHistory`
- `src/lib/gmail.functions.ts` — extend `listPubsubEvents` stats with `gmailErrors24`
- `src/components/settings/PubsubActivity.tsx` — new tile + info banner