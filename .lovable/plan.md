## Goal

Make Zerrow's read/unread state simple and predictable:

- Folder has **auto-mark-read = ON** → mark the email read in Zerrow (and tell Gmail to mark it read). Unchanged.
- Folder has **auto-mark-read = OFF** (or no folder) → **just mirror Gmail's actual read state.** No forcing to unread.

This undoes the earlier "Factory keeps everything unread regardless of Gmail" behavior, which is what's causing Zerrow to show a huge unread count while Gmail shows them read.

## Changes — `src/lib/sync.server.ts`

1. **Classification path (lines 375–379)** — delete the `else if (parsed.is_read)` branch that forces `is_read = false` when the assigned folder has `auto_mark_read=false`. New mail just keeps whatever read state Gmail reports.

2. **`applyLabelChange` (lines 713–726)** — delete the guard that suppresses `patch.is_read = true` for no-auto-read folders. Always mirror Gmail's UNREAD label change.

3. **`reconcileLocalInbox` (lines 1070–1074)** — always set `patch.is_read = gmailRead`. Drop the `noAutoRead` check.

4. **Archived reconcile pass (lines 1115–1120)** — same: always set `patch.is_read = !unread`.

5. **Cleanup** — remove the now-unused `loadNoAutoReadFolderIds` helper and the `folder_id` columns added solely for that gating (keep them if they're still referenced elsewhere — quick check during the edit).

## Backfill (one-off migration)

Sync the current backlog so the Inbox unread count immediately matches Gmail:

```sql
UPDATE public.emails
SET is_read = NOT ('UNREAD' = ANY(raw_labels))
WHERE is_read = false
  AND NOT ('UNREAD' = ANY(COALESCE(raw_labels, '{}')));
```

This flips every row Zerrow currently shows as unread but Gmail considers read (no UNREAD label) to read. Rows that are genuinely unread in Gmail stay unread.

## What stays the same

- Folders with **auto-mark-read = ON** still mark mail read in both Zerrow and Gmail.
- Manual mark read / unread in Zerrow still pushes to Gmail.
- Archive, trash, label sync — untouched.

## Result

After this change + backfill, the Zerrow unread badge will match Gmail's unread count. Going forward, Gmail is the source of truth for read state unless a folder explicitly opts in to auto-mark-read.
