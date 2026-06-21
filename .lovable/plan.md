# Fix the slow "Catching up…" inbox gate

## Problem

On first open of an account, the inbox hides the whole list behind a full-screen "Catching up…" placeholder (`isCatchingUp`) until the heavy `triggerSync` server function finishes. `triggerSync` runs, in sequence:

1. `syncSinceHistory`
2. `drainCatchupRounds` — up to 6 rounds / 12s budget
3. `backfillRecent` (30 messages)
4. `reconcileLocalInbox` (up to ~20 sequential Gmail API calls)

The local database is already the source of truth and loads in milliseconds, so blocking the render on this entire Gmail round-trip is what makes it feel stuck.

## Approach

The local email list should appear immediately; the Gmail sync should refresh it in the background with a non-blocking indicator. We already have the lighter `backgroundSync` (history + bounded catch-up only, no backfill/reconcile) and a subtle inline "Catching up…" pulse in the list header — we reuse both.

### 1. Make the first-open sync lightweight and non-blocking (`inbox.tsx`)
- In the first-open `useEffect` (around lines 687-708), call `backgroundSync` instead of the heavy `triggerSync`, and **do not** flip `isCatchingUp` when the local list already has data. The list renders from cache/DB instantly; the sync then quietly refetches `["emails"]`.
- Keep the heavy `triggerSync` (backfill + reconcile) only on the manual Refresh button and the existing cron/5-min lanes.

### 2. Only gate on a true cold start, with a hard cap (`inbox.tsx`)
- Show the blocking "Catching up…" placeholder (lines 1286-1349) **only** when there are genuinely no emails to show yet (`emailsQ` has no cached data and is still loading) — never when a populated list exists.
- Add a short safety timeout (~3-4s) so even a cold start reveals whatever has loaded and falls back to the inline header indicator + realtime, instead of holding the full-screen gate open.

### 3. Keep the live indicator subtle
- While the background open-sync runs, rely on the existing inline header pulse ("Catching up…", lines 1120-1124) rather than the full-screen overlay, so the list stays visible and interactive the entire time.

## Result

- Returning to the inbox: the list shows instantly from the local DB; new mail flows in within a second or two via the background sync + realtime, with only a subtle header pulse.
- Cold start (no local data yet): a brief gate that self-clears within a few seconds.
- Manual Refresh still runs the full backfill + reconcile.
- No database, schema, realtime, or cron changes.

## Files
- `src/routes/_authenticated/inbox.tsx`
