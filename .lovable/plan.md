I confirmed the Shane Reinert message is still showing because Zerrow's database still has it as `is_archived = false` with `raw_labels` containing `INBOX`. So the Inbox UI is doing what the local data says; the missing piece is that the Gmail archive label change did not automatically reconcile into Zerrow.

I also found a likely sync gap: the Gmail history sync reads only the first history page. If Gmail returns multiple pages of history events, a later `INBOX` label removal can be skipped while Zerrow still advances the account's history cursor, making that archive event effectively missed.

Plan:

1. Fix Gmail history pagination
   - Update the Gmail history helper to support `pageToken`.
   - Update `syncSinceHistory` to process every history page, with a safe page cap to avoid runaway loops.
   - Only advance the stored Gmail history cursor after all pages are processed.
   - This prevents future archive/unarchive events from being skipped during busy inbox periods.

2. Add active Inbox self-healing
   - Add an authenticated server function that accepts the currently visible Inbox email IDs.
   - It will validate ownership, fetch lightweight Gmail labels for those messages, and update `raw_labels`, `is_archived`, and `is_read` when Gmail differs.
   - The Inbox page will call this quietly on an interval while the page is open, so rows archived directly in Gmail disappear without clicking refresh or reloading.

3. Wire the UI to realtime removal
   - The server-side label repair will update the `emails` row.
   - The existing realtime subscription will then remove the row from the Inbox cache because archived rows no longer belong in `all`/Inbox.

4. Repair the known stale row(s)
   - Run a targeted resync/cleanup so the Shane Reinert message and any similar currently stale Inbox rows are corrected immediately.

5. Add regression coverage
   - Add/extend tests for Gmail history pagination behavior.
   - Add a small testable helper for applying Gmail label snapshots so archive state and `raw_labels` stay consistent.