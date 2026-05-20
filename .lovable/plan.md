# Fix the misleading "push didn't match" banner + verify the re-arm worked

## What's actually going on

I queried `pubsub_events`. The full picture:

| time | event | notes |
|------|-------|-------|
| 18:23:19 | `watch_renew` | Your re-arm worked. Bound to `projects/projectinboxzero-495314/topics/gmail-push`, expires 5/27. |
| 18:24, 18:22, 18:20, 18:18 … | `poll` | Polling keeps catching up every 2 min. |
| **18:12:05** | `push` | **This is the row the banner is yelling about.** It happened ~12 min *before* the re-arm, and predates the migration so it has no `payload` / `message_id` columns to inspect. |
| 18:12:05 | `push_empty` | Same envelope as above — body had no `message.data`. |

So the banner is reacting to a stale push from before you re-armed. It does NOT mean the re-arm failed. We just don't know yet, because **Gmail only emits a push when new mail actually changes the inbox** — the watch alone doesn't trigger one.

## Plan

### 1. Make the "push didn't match" banner age-aware

In `src/components/settings/PubsubActivity.tsx`, only show the red "Push arrived but didn't match" banner when **`lastPush.received_at` is within the last 10 minutes AND newer than the most recent `watch_renew` event**. Otherwise the diagnostic is stale and actively misleading.

Same for the "Last push" expandable card — show an `(stale, before last re-arm)` chip so you immediately know it's not the current picture.

### 2. Surface re-arm freshness

Add a small status line under the diagnostics header:
- "Watch re-armed 1m ago against `projects/projectinboxzero-495314/topics/gmail-push`. Send yourself an email to verify push delivery."
- Computed from the most recent `watch_renew` row's `details` + `received_at`.

### 3. Add a "Verify push end-to-end" affordance

Right next to the re-arm button, add a small **"How to verify"** helper that just renders 2 lines:
1. Send yourself an email from another account.
2. Watch this panel for a new `push` row within ~30s. If only `poll` rows show up, the GCP subscription is the broken piece.

(No code that actually sends mail — we can't, it'd send from your own connected account.)

### 4. Extend the `lastPush` query to skip pre-instrumentation rows

`listPubsubEvents` in `src/lib/gmail.functions.ts`: when picking `lastPush`, prefer the most recent push that has `payload IS NOT NULL` (i.e. logged by the new webhook). Fall back to the truly latest row only if no instrumented push exists yet. That way the "Last push details" block stops showing the 18:12 ghost.

### 5. Also fetch the latest `watch_renew` and expose it

Extend `listPubsubEvents`'s `diagnostics` return with `lastWatchRenew: { received_at, details }` so the UI doesn't need a second round trip to show #2.

## Files to touch

- `src/lib/gmail.functions.ts` — `listPubsubEvents`: pick `lastPush` preferring instrumented rows; add `lastWatchRenew` to `diagnostics`.
- `src/components/settings/PubsubActivity.tsx` — age-gate the "didn't match" banner; "stale" chip on Last push card; re-arm freshness line; "How to verify" helper.

## Out of scope

- No backend / webhook / sync changes. The webhook instrumentation from the last turn is already correct; we just need to interpret the data more carefully in the UI.
- Anything inside Google Cloud Console.
- Polling, classifier, job worker.

## What you'll see after this

- The red banner disappears (the only offending push is from 12+ min ago and predates the re-arm).
- A new status line: *"Watch re-armed 1m ago against `projects/projectinboxzero-495314/topics/gmail-push`. Send yourself an email to verify push delivery."*
- When you send yourself a test email, a fresh `push` row appears with a fully populated payload — at which point we'll know definitively whether the topic/subscription wiring is right or still broken.