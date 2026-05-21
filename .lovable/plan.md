## Goals

1. Add a top-level **Move to Inbox** action in the right-click menu so any email — including archived ones surfaced from search or a folder view — can be pulled back into the Inbox in one click.
2. Make the existing past-emails behavior more obvious: the "Remove folder label from past emails" option already removes the folder label without re-adding `INBOX` (archived mail stays archived, just unlabeled). Reword it so the intent is clear.

## Changes — `src/routes/_authenticated/inbox.tsx`

### 1. Add a top-level "Move to Inbox" menu item

Today the only way to move an email to the inbox is **Move to folder → Inbox (no folder)**, and that sub-item only renders when `currentFolderId` is set. From the global Inbox view, an archived/foldered email shown via search has no visible path back to the inbox.

Add a new `ContextMenuItem` at the top of `ContextMenuContent` (above the **Move to folder** submenu) labeled **Move to Inbox**, using the `Inbox` icon. Show it only when the email is archived OR has a `folder_id` (otherwise it's already in the inbox). Handler:

- Optimistically update the cached row to `{ folder_id: null, is_archived: false, classified_by: "manual_inbox" }`.
- Call `moveEmailToInbox({ email_id: e.id })` (already imported, server fn already removes the old Gmail label and adds `INBOX`).
- Toast "Moved to inbox" on success; invalidate `["emails"]`.

### 2. Reword the past-emails strip option

The label "Remove folder label from past emails" is ambiguous — users worry it might also re-inbox the messages. The current server fn `stripFolderLabelPast` deliberately preserves archived state (`is_archived: !raw_labels.includes("INBOX")`), which is exactly the "looks like it was inboxed then archived" behavior the user wants.

Rename the two menu items (sender and domain submenus) from:

> Remove folder label from past emails

to:

> Remove folder label from past emails (keep archived)

No backend change.

## What stays the same

- **Future emails only** and **Future and past emails** options are untouched.
- `moveEmailToInbox` and `stripFolderLabelPast` server functions are unchanged.
- `Move to folder → Inbox (no folder)` inside folder views still works.

## Result

- Right-click any email anywhere → **Move to Inbox** appears whenever the email isn't already in the inbox.
- The past-emails option clearly states it keeps mail archived, not re-inboxed.
