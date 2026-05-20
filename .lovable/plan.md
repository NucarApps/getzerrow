# Add "All mail" folder + folder pill on list rows

## What changes

1. **New sidebar entry: "All mail"** — shows every email regardless of folder or archived state (the existing "All inbox" stays as-is and keeps excluding archived/foldered mail).
2. **Folder pill on list rows** — when an email's `folder_id` matches one of the user's folders, render a small colored pill with the folder name next to the sender line.

## Where

- `src/lib/folder-selection.tsx` — extend `FolderSelection` type to include `"all_mail"`.
- `src/routes/_authenticated.tsx` — add a `FolderRow` for "All mail" right under "All inbox". Count = total emails (or unread count across everything, matching the existing pattern).
- `src/routes/_authenticated/inbox.tsx`:
  - In `emailsQ.queryFn`, add a branch: when `selectedFolder === "all_mail"`, don't filter by `is_archived` and don't filter by `folder_id` — just order by `received_at` desc with the same pagination.
  - In `labelForFolder` helper, return `"All mail"` for that key.
  - In the list row JSX (around line 333), look up `foldersQ.data.find(f => f.id === e.folder_id)` and, if present, render a pill: small rounded badge using the folder's `color` (background at low opacity, colored text/border) with the folder name. Place it inline next to the sender name or under the subject — under the subject is cleaner so long folder names don't push out the timestamp.

## Pill styling

Use a thin rounded pill, `text-[10px]`, uppercase tracking, `bg` = folder color at ~15% opacity, `text` = folder color, no border. One pill per row max. Hidden when row is in a specific folder view (redundant) — only show on "All inbox", "All mail", "No rules", and search results.

## Out of scope

- No changes to sync, server functions, or DB schema.
- No multi-label support (we only show the single `folder_id` mapping).
- "No rules" view behavior is unchanged.
