I found two likely causes for archived messages still appearing in Zerrow Inbox:

1. The Inbox list currently trusts `raw_labels` containing `INBOX` and does not also require `is_archived = false`. Any drift row with both `raw_labels` containing `INBOX` and `is_archived = true` can still show in Inbox.
2. One remaining server path (`applyRetroactiveFolderBehavior` when archiving a folder retroactively) sets `is_archived = true` but does not strip `INBOX` from `raw_labels`, recreating the exact drift we just repaired.

Plan:

1. Update the Inbox page query and realtime membership rule so Inbox requires both:
   - `raw_labels` includes `INBOX`
   - `is_archived` is false

2. Update the retroactive folder archive action so when it archives messages it also removes `INBOX` from `raw_labels`, keeping local state consistent with Gmail.

3. Run a one-time data cleanup for existing drift rows:
   - remove `INBOX` from `raw_labels` where `is_archived = true`
   - specifically also clean rows in folders configured to auto-archive or hide from inbox

4. Add/adjust regression tests for:
   - realtime Inbox membership rejecting rows where `is_archived = true` even if `raw_labels` still contains `INBOX`
   - retroactive archive state stripping `INBOX` from `raw_labels`

After this, even if one stale row slips through, the Inbox UI will not show it, and the remaining backend path that creates stale labels will be fixed.