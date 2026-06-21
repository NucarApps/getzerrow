# Instant + continuously-updating inbox

## Problem
1. **On open:** the inbox shows your last-known (stale) emails, then new mail **trickles in one row at a time** as a background lane drains queued jobs every 5s.
2. **While open:** new mail only reliably appears on manual Refresh or a page reload — there's no steady background pull keeping the open inbox current.

Cause: the list renders the DB immediately; the fast **bulk catch-up path** (`bulkCatchupClaim`) only runs on the Refresh button and processes a single batch (~30); and there is **no recurring background sync** while the inbox is mounted. Realtime only reflects whatever the slow cron lane has already processed.

## Goal (per your choices + this request)
- On open: brief **"Catching up…"** indicator, then render the **fully up-to-date** list at once — no stale rows, no row-by-row trickle.
- **Long absences:** drain new mail in **several bounded batches** so most lands at once; remainder falls back to the background lane.
- **While the inbox stays open:** it **keeps itself current automatically** on a steady interval (and on tab refocus) — no manual refresh or reload needed.

## Approach

### 1. Make catch-up drain multiple batches (server)
Turn the single bulk pass into a bounded loop so backlogs mostly clear in one sync, while staying under the browser request wall-clock (Safari "Load failed").

- Add knobs in `src/lib/sync/config.ts`:
  - `CATCHUP_MAX_ROUNDS` (e.g. `6`)
  - `CATCHUP_TOTAL_BUDGET_MS` (e.g. `12_000`)
- In `triggerSync` (`src/lib/gmail.functions.ts`), after `syncSinceHistory`, loop `bulkCatchupClaim` instead of calling it once: continue while the previous round reported `overflowed === true` and `scanned > 0`, stopping at `CATCHUP_MAX_ROUNDS` or once elapsed time exceeds `CATCHUP_TOTAL_BUDGET_MS`. Aggregate per-round results and return a final `overflowed` flag.
- Add a lighter server fn `backgroundSync` (same file) for the recurring path: runs `syncSinceHistory` + the bounded `bulkCatchupClaim` loop, but **skips** the heavier `backfillRecent` + full `reconcileLocalInbox` (those stay on the existing 5-min loop and cron). This keeps each background tick cheap.

### 2. Auto catch-up on open, gated by a brief state (client)
In `src/routes/_authenticated/inbox.tsx`:
- Add `isCatchingUp` state + a per-account "ran once this mount" ref.
- `useEffect` on `accountId`: on first availability set `isCatchingUp = true`, call `triggerSync`, `await qc.refetchQueries({ queryKey: ["emails"] })`, then clear the flag (try/finally so it always clears; failures fall back to the cached list).
- **Render gating:** on the first open of the session, show a lightweight "Catching up…" placeholder (reuse existing skeleton styling) while `emailsQ.isLoading || isCatchingUp`, so stale rows + trickle are never shown. The finished list then appears in one update. Subsequent in-session navigations show the cached list instantly.

### 3. Continuous background updates while open (client)
Also in `inbox.tsx`, add a recurring background refresher (separate from the gated open path, **never** shows the "Catching up…" gate):
- A `setInterval` (e.g. every `BACKGROUND_SYNC_INTERVAL_MS` ≈ 30s) that calls the new `backgroundSync({ data: { account_id } })`, then patches the list via realtime + a quiet `qc.invalidateQueries({ queryKey: ["emails"] })`. New mail appears in place with no flashing or spinner.
- **Visibility-aware:** pause the interval when `document.visibilityState !== "visible"`; run one immediate tick when the tab regains focus (reuse the existing visibilitychange pattern already used for read-state sync).
- **Overlap guard:** a ref flag skips a tick if a sync (background, manual Refresh, or the open catch-up) is already in flight, so calls never stack.
- Tear down the interval and listener on unmount.
- Realtime stays wired as-is; the background tick is the safety net that guarantees consistency even when Gmail push/webhook is delayed.

### 4. Keep it snappy when nothing is new
The "Catching up…" indicator only shows while the open call is in flight; with no new mail it resolves near-instantly. Background ticks are silent and cheap (`syncSinceHistory` + at most a small drain). The bounded budgets guarantee neither path can hang the UI.

## Files touched
- `src/lib/sync/config.ts` — add `CATCHUP_MAX_ROUNDS`, `CATCHUP_TOTAL_BUDGET_MS`, `BACKGROUND_SYNC_INTERVAL_MS`.
- `src/lib/gmail.functions.ts` — bounded multi-round loop in `triggerSync`; new lightweight `backgroundSync` server fn.
- `src/routes/_authenticated/inbox.tsx` — open catch-up with `isCatchingUp` gating; visibility-aware background sync interval with an overlap guard.

No database/schema changes, no new public endpoints. Existing RLS, realtime, cron lanes, reconcile loop, and the manual Refresh button keep working.

## Verification
- Open with queued mail: brief "Catching up…" → full updated list at once, no trickle.
- Large backlog (>30): most lands in the batched sync; remainder fills via the background lane.
- Leave the inbox open and send/receive new mail: it appears within ~30s with no refresh, no spinner, no reload.
- Switch tabs away and back: a sync fires immediately on refocus.
- No new mail: open is near-instant; background ticks are silent and don't cause flicker.
- Manual Refresh still works and now drains larger batches.
