## Two changes in `src/routes/_authenticated/inbox.tsx`

### 1. "Move to folder" via right-click doesn't leave the inbox

**What's happening:** The server (`performMove`) already sets `is_archived: true` and removes the Gmail `INBOX` label, and the optimistic cache update flips the row to `is_archived: true`. The Inbox tab query filters `is_archived = false`, so the row should disappear immediately.

The reason it appears to "stay" is the realtime channel: as soon as the server writes, a `postgres_changes` event fires and we call `qc.invalidateQueries(['emails'])`. The refetch races with the optimistic update, and if the Gmail label round-trip hasn't propagated to the sync worker yet, a subsequent reconcile can flip `is_archived` back to `false` (the message still has `INBOX` in `raw_labels` from the previous snapshot until the next push). Net effect: the row reappears in the Inbox view.

**Fix:**

- In the right-click "Move to folder" handler (around line 779), keep the optimistic patch but **also remove the row from any non-matching folder query caches immediately**, the same way the swipe-archive handler does. Specifically, after the optimistic `setQueriesData`, drop the row from the `selectedFolder === "all"` cache so it disappears even if a stale realtime event arrives.
- Skip the immediate `invalidateQueries(['emails'])` after a successful move and instead schedule it on a short delay (~1.5s) so the server-side label sync settles before the refetch runs. The realtime subscription will still pick up any later corrections.
- Apply the same treatment to the "Move to folder" submenu's "Inbox (no folder)" item and the bulk-move path, for consistency.

This mirrors the pattern already used by the swipe-archive flow and removes the race that lets a moved email reappear in Inbox.

### 2. Show a folder chip on rows in Inbox and All mail

Add a small color-dot + name pill rendered inside the row header, **only when** `selectedFolder === "all"` (Inbox) or `selectedFolder === "all_mail"` (All mail), and only when `e.folder_id` resolves to a folder in `folderList`.

- Look up `const rowFolder = folderList.find(f => f.id === e.folder_id)`.
- Render next to (or just under) the sender/subject line:
  ```
  <span class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]">
    <span class="h-1.5 w-1.5 rounded-full" style={{background: rowFolder.color}} />
    {rowFolder.name}
  </span>
  ```
- Tokenized: use `border-border`, `text-muted-foreground`, and the folder's own color for the dot only (folder colors are user-chosen and live outside the token system, which matches how the context menu already renders them).
- Hidden on every other tab (folder view, No rules, search results) to avoid redundant noise where the folder is already implied by the view.

### Out of scope

- No server changes; `performMove` already does the right thing.
- No changes to swipe-archive, bulk select toolbar, or AI re-classify flows.
