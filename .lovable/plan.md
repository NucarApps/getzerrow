# Condense inbox list rows

Keep: sender, subject, time, AI summary. Drop the visual chrome between them.

## Changes in `src/routes/_authenticated/inbox.tsx` (rows ~389–438)

1. **Reduce row padding**: `py-3` → `py-2` on the row button (line 391).
2. **Remove the chips row entirely** (lines 403–421): folder pill, ClassifiedChip, AI confidence %. Folder context already shows in the sidebar/header; chip is redundant.
3. **Remove the reason text line** (lines 422–429) — `"Global inbox list: domain ..."`. It moves to the detail pane's "Why this folder?" section already.
4. **Keep AI summary as-is** but tighten: `line-clamp-2` → `line-clamp-1` so each row stays at most one line of summary. Snippet fallback stays unchanged for rows without an AI summary.

Result rows become:
```
Sender                                   12h
Subject line
✨ One-line AI summary
```

Three tight lines, no chips, no reason text. Roughly halves row height.

## Cleanup
- `rowFolder`, `reasonText`, `ClassifiedChip` in this row scope become unused locally — leave the variables alone if they're computed inline (low risk) or remove if it's a clean delete. The detail pane still uses ClassifiedChip and reason text, so no shared component is removed.
