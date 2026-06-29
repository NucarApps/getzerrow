## Plan

1. **Finish the server-side reconciliation fix**
   - Update `src/routes/api/public/gmail-reconcile.ts` to honor the new `max_accounts` cron parameter.
   - Process only the oldest-due accounts by `last_reconcile_at ASC NULLS FIRST` so reconciliation rotates instead of timing out by trying every account in one request.
   - Stamp `last_reconcile_at` in a `finally` block after each account attempt so one slow/broken account does not starve the others.

2. **Fix the stale UI refresh edge cases**
   - Correct the `pullOlderMut` refetch query key from `['emails', selectedFolder]` to an account-aware key so it actually matches the inbox list cache.
   - Avoid the manual Refresh button showing a stale pre-sync refetch by refetching the email list after the Gmail/background sync finishes, not before it.

3. **Keep realtime structurally safe**
   - Move `useEmailRealtime()` inside `AccountSelectionProvider` so future account-scoped realtime behavior can use the same account context as the inbox.
   - Do not change unrelated inbox behavior or SEO/security findings.

4. **Verify**
   - Confirm cron calls are returning 200 and `poll`/`reconcile` events are logging.
   - Run the existing realtime/inbox-related tests after implementation.
