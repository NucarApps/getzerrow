## Plan

Fix the inbox so it mirrors Gmail’s Inbox state instead of relying on a stale local `is_archived` flag.

### 1. Make archive mutations update the same state the inbox reads
- Update `archiveEmail` to patch `raw_labels` by removing `INBOX`, not just set `is_archived: true`.
- If the Gmail archive API call fails, throw the error instead of silently marking the local row archived, so Zerrow cannot drift from Gmail.
- Apply the same `raw_labels` sync to manual “move to folder” paths and folder auto-archive side effects where needed.

### 2. Make list/count logic use Gmail’s canonical Inbox label
- Keep the inbox list filtered by `raw_labels contains INBOX`.
- Update the top Inbox unread count to count unread rows with `raw_labels` containing `INBOX`, not unread rows where `is_archived = false`.
- This fixes rows like the one currently visible in your network data: `is_archived: true` but `raw_labels: ["...", "INBOX"]`, which means Gmail still considers it in Inbox.

### 3. Strengthen realtime cache patching
- Change realtime `UPDATE` handling so when a row no longer belongs in the current Inbox view, it is removed from the cached list immediately.
- Ensure optimistic archive actions remove rows from all current Inbox caches, not just flip fields in place.

### 4. Add regression tests
- Add/adjust unit tests for archive-label behavior and realtime list membership so `INBOX` label state remains the source of truth.

### Verification
- Run the relevant Vitest tests for realtime/list behavior.
- Verify in the preview that archiving an Inbox email removes it immediately and that after refetch it stays removed unless Gmail still has the `INBOX` label.