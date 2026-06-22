## Plan

1. **Fix the real backend cause of the “one-by-one disappearing” effect**
   - Update the queued AI classification worker so when it assigns an email to a folder, it also applies the folder’s final effects immediately: auto-archive, hide from inbox, mark read, star, snooze, forwarding, and local flags.
   - This removes the current gap where batched/backfill AI sets `folder_id` but leaves the row looking like it still belongs in the inbox until a later reconcile/page-load repair updates it.

2. **Make the Inbox list show only settled, actionable inbox mail**
   - Update the inbox list database function so the default Zerrow Inbox excludes mail that is already assigned to a folder whose rules say it should be hidden/archived, even if local Gmail-label state is temporarily behind.
   - Keep folder views and All mail usable for inspecting filed mail.

3. **Apply the same visibility rules everywhere the inbox reads mail**
   - Update unread counts to match the same “settled actionable inbox” contract.
   - Update direct search queries in the inbox UI so search does not leak `pending` / `pending_ai` rows or hidden-folder rows into the visible list.

4. **Remove page-load repair as the thing users notice**
   - Keep the entry catch-up as a safety net, but make it unable to reveal mail that is still being sorted or already filed.
   - Keep realtime updates, but make them only add mail to the Inbox after it truly belongs there.

5. **Verify with backend data and tests**
   - Add/update tests for the realtime visibility rules.
   - Check recent database rows before and after the fix to confirm mail in auto-archive/hidden folders no longer appears in the Inbox.
   - Run the targeted inbox/realtime tests after implementation.