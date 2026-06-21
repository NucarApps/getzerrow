## Goal
When the user opens Zerrow inbox, the list should reflect the latest processed Gmail state before it settles on screen. It should not show stale rows first and then visibly move emails after page load.

## Plan

1. **Add a dedicated “sync before list” server function**
   - Add a lightweight authenticated function in `src/lib/gmail.functions.ts` for inbox entry.
   - It will verify account ownership, run Gmail history sync, drain the catch-up queue in bounded rounds, and return quickly.
   - Keep heavy backfill/reconcile work out of this path so opening the inbox does not hang for 15–20 seconds.

2. **Gate the inbox list query on that pre-sync**
   - In `src/routes/_authenticated/inbox.tsx`, run the entry sync query before `getInboxList` is enabled for the selected account.
   - Once the entry sync completes or times out safely, fetch the inbox list from the database.
   - This changes the sequence from:

```text
load inbox list -> start catch-up -> refetch/move rows
```

   to:

```text
bounded catch-up -> load inbox list once with latest processed state
```

3. **Keep the UX fast with a strict safety cap**
   - Show the existing “Catching up…” state only during the initial pre-sync when there is no list ready yet.
   - Add a short client-side timeout fallback so a slow Gmail API call never blocks the inbox indefinitely.
   - If timeout happens, load the best current database state and let the existing server crons/realtime finish quietly.

4. **Keep live updates after load**
   - Preserve the existing realtime updates and recurring open-inbox background sync.
   - Manual Refresh will still run the heavier full sync/backfill/reconcile path.

5. **Verify behavior**
   - Confirm the inbox no longer renders stale data before the first catch-up finishes.
   - Confirm manual Refresh still works and the existing live update loop remains active.