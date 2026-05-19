Fix the refresh behavior so the app does not rely only on Gmail history events.

Plan:
1. Add a server-side reconciliation step after manual inbox refresh.
   - Load the current app-visible inbox rows for the selected Gmail account.
   - Fetch each message’s current Gmail labels.
   - If Gmail no longer has `INBOX`, mark the app row archived so it disappears.
   - If Gmail has `TRASH` or the message no longer exists, remove the app row.
   - Keep `raw_labels` and `is_read` in sync too.

2. Wire that reconciliation into the existing `triggerSync` / refresh path.
   - Keep the existing Gmail history sync for new messages and normal updates.
   - Run reconciliation afterward as a safety net for missed history events.
   - Return a small count of reconciled/archived/deleted rows for debugging.

3. Leave the UI and database schema unchanged.
   - The existing refresh button will behave the same visually.
   - After clicking it, those Tony/Nightly Close/Chris rows should disappear if they are no longer in Gmail Inbox.

Technical details:
- Update `src/lib/sync.server.ts` with a `reconcileLocalInbox` helper.
- Update `src/lib/gmail.functions.ts` so `triggerSync` calls it after `syncSinceHistory`.
- No migrations or new tables are needed.