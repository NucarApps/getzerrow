Plan:

1. **Fix the auto-archive pipeline**
   - Update the message-processing side-effect logic so when a folder has `auto_archive` or `hide_from_inbox`, Zerrow removes `INBOX` from the email’s local `raw_labels` at the same time it marks the row archived.
   - Only apply the local archive state after the Gmail label change succeeds, so Zerrow stays aligned with Gmail instead of showing processed-but-still-inbox rows.

2. **Repair the already-stuck rows**
   - Add a safe repair path for existing emails that are already assigned to auto-archive folders, already marked archived, but still have `INBOX` in `raw_labels`.
   - This will specifically clear the stale local Inbox label for messages like the StoneEagle Reports rows once Gmail has archived them.

3. **Protect the behavior with tests**
   - Add or update regression tests around processed folder emails so an archived/report-classified message cannot continue to belong to the Inbox view because of stale `raw_labels`.

Technical details:
- The current Inbox view correctly uses Gmail’s `INBOX` label as the source of truth.
- The bug is in `process-message.ts`: folder auto-archive sets `is_archived: true` but does not update `raw_labels`, so realtime and refetches still see `INBOX` and keep the message visible.
- The screenshot matches database state: the StoneEagle rows are classified into `Reports` and `is_archived=true`, but their `raw_labels` still include `INBOX`.