Move folder navigation into the left sidebar and convert the Folders page into per-folder edit dialogs.

## New left sidebar layout
- Keep the brand at the top, and `Inbox` and `Settings` as top-level links.
- Add a `Folders` section header with a `+` button on the right that opens an "Add folder" dialog (name + Gmail label select, same fields as today's add row).
- Below the header, list every folder (color dot, name, unread count) — same data the inbox column shows today.
- Add `All inbox` and `Unsorted` as the first two entries in the folder list so nothing is lost.
- Clicking a folder navigates to `/?folder=<id>` (or `all` / `unsorted`); the inbox reads the selected folder from the URL instead of local state.
- On hover, each folder row reveals a `⋯` button. Clicking it opens an "Edit folder" dialog containing the existing `FolderEditor` (color, Gmail label, AI rule, learned profile + suggested domains, auto-archive / mark-read, filters, delete).

## Inbox screen
- Drop the 220px folders column. The inbox becomes a two-pane layout: message list (left) and reader (right).
- Move the refresh button into the message-list header.
- The selected-folder state moves from `useState` to a URL search param so the sidebar can drive it.

## Folders route
- `/folders` becomes redundant. Redirect it to `/` so existing links / bookmarks still work, and remove the `Folders` item from the sidebar nav (its functionality is now the sidebar section + dialogs).

## Technical details
- Files touched:
  - `src/routes/_authenticated.tsx` — render the new folder section (queries `folders`, `emails` unread counts, `gmail_accounts`, `gmail-labels`); wire add + edit dialogs; subscribe to the same realtime channel for folders/emails so the sidebar updates live.
  - `src/routes/_authenticated/index.tsx` — remove the folders column; read `?folder=` from the URL; keep realtime + list/reader panes.
  - `src/routes/_authenticated/folders.tsx` — replace with a redirect to `/`. Extract `FolderEditor` and the add-folder form into `src/components/folders/FolderEditor.tsx` and `AddFolderDialog.tsx` so the sidebar can reuse them.
- New shadcn pieces used: `Dialog` (already installed) for add + edit, `DropdownMenu` for the `⋯` action, optional `ScrollArea` for the folder list.
- No database or server-function changes.