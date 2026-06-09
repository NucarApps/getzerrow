# Fix "Load Failed" toast on inbox refresh

## What's actually happening

"Load Failed" is Safari/WebKit's generic wording for a network request that didn't
complete (`TypeError: Load failed`). It is being shown by the Refresh button's error
handler, which prints the raw error text as a toast.

The account itself is healthy — I verified in the live database:

- Connection is valid: no reconnect needed, recent successful poll, active Gmail watch.
- No stuck or failed sync jobs.
- The inbox query runs in ~0.1 ms and returns its messages instantly.
- No oversized email bodies or encryption-key mismatches.
- The live sync pipeline (webhook + background jobs) is returning success.

So the data is fine and is already kept current in the background. The problem is the
Refresh button itself: pressing it runs a single request that does too much
synchronous work against Gmail.

### Why the request fails intermittently

The Refresh icon calls one server action (`triggerSync`) that, in one request, does:

1. A Gmail history sync,
2. A 30-message recent backfill, and
3. A "reconcile" pass that makes up to ~100 sequential Gmail API calls (plus a
   second pass over archived messages).

That last step is the culprit. Dozens-to-hundreds of back-to-back Gmail calls in a
single request routinely run long enough that the browser (especially mobile Safari)
gives up on the request — producing "Load Failed." Because the reconcile work is
proportional to how much Gmail churn there is, it shows up as a flaky, recurring error
rather than a hard failure. The background cron already performs this reconcile, so the
manual refresh doing it again is mostly redundant.

## The fix

Make Refresh fast, and never let a flaky Gmail round-trip blank the inbox or throw a
scary toast.

```text
Refresh button
   │
   ├─ Re-query the inbox from the database (fast, reliable, already up to date)
   │
   └─ Kick a LIGHT Gmail sync (history + small backfill), best-effort
        ├─ success → "Synced · N new"
        └─ network error → quietly ignore; the DB refresh already happened
```

### Steps

1. **Trim the manual sync's heavy step.** In `triggerSync`, stop running the full
   100-message reconcile on every manual refresh. Either drop it from the manual path
   (the background cron already does it) or cap it to a very small batch so the request
   returns in a second or two.

2. **Make the Refresh button resilient.** In the inbox page, always refetch the
   email/folder queries from the database first (this is the real source of truth and
   is already current). Then trigger the light Gmail sync as best-effort.

3. **Stop surfacing raw "Load Failed."** Replace the error handler so a network-level
   failure does not show the raw message. If the DB refresh succeeded, show nothing (or
   a subtle "Up to date"); only show a friendly, retryable message if something real
   went wrong.

4. **Add a short timeout + single silent retry** around the Gmail sync call so a
   one-off blip self-heals instead of bubbling up.

## Verification

- Press Refresh repeatedly on chanelldagesse@gmail.com on the live site and confirm no
  "Load Failed" toast appears and the list updates promptly.
- Confirm new mail still appears (background sync + DB refetch).
- Confirm the other two accounts still refresh normally.

## Technical notes

- Files: `src/lib/gmail.functions.ts` (`triggerSync` handler, ~line 745) and
  `src/routes/_authenticated/inbox.tsx` (`syncMut`, ~line 904, and its `onError`).
- The expensive call is `reconcileLocalInbox(accountId, 100)` in `triggerSync`, which
  loops up to the limit calling `getMessageLabels` / `getMessage` per row in
  `src/lib/sync/reconcile.ts`. Reducing the limit (or removing it from the manual path)
  is safe because the cron reconcile is the designated backstop.
- No database, schema, or migration changes are needed. This is a frontend +
  server-function behavior change only.
