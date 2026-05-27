## Problem

In the All Mail view, right-clicking an email that isn't archived and has no folder (just doesn't carry the `INBOX` label) shows no way to put it back into the inbox. The "Move to Inbox" context menu item in `src/routes/_authenticated/inbox.tsx` is currently gated on `e.is_archived || e.folder_id`, which misses this case.

## Change

In `src/routes/_authenticated/inbox.tsx`, broaden the gate so "Move to Inbox" appears whenever the row is not currently in the inbox:

- Replace the condition `(e.is_archived || e.folder_id)` around the "Move to Inbox" `ContextMenuItem` with a check that also covers "no INBOX label": `!(e.raw_labels ?? []).includes("INBOX") || e.is_archived || e.folder_id`.
- The existing `onSelect` already calls `moveInboxFn` (the `moveToInbox` server function) which adds `INBOX` back via Gmail and clears `folder_id`/`is_archived` — no server change needed.
- Optimistic update already uses `withInbox(x.raw_labels)`, so the row reappears in the Inbox view immediately.

No other views or business logic change. The "Move to folder → Inbox (no folder)" sub-item stays as-is.

## Out of scope

- No changes to server functions, sync pipeline, or Gmail label handling.
- No UI changes outside this context menu.
