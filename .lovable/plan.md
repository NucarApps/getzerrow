## Problem

In the Edit folder sheet, the Delete (trash) button sits in the header row right next to the sheet's close (X) button. On mobile that's a thumb's-width away — easy to tap Delete by accident.

## Change

In `src/components/folders/FolderEditor.tsx`, replace the inline Delete icon button (line 206) with a three-dot (MoreVertical) `DropdownMenu` trigger. The menu contains a single destructive "Delete folder…" item that calls the existing `remove()` handler (which already shows a confirm dialog).

- Trigger: `Button variant="ghost" size="icon"` with `MoreVertical` icon — same footprint as today, but a neutral icon instead of a red trash.
- Menu item: `DropdownMenuItem` styled with `text-destructive` + `Trash2` icon, label "Delete folder…".
- Keeps the existing `confirm()` step in `remove()` as a second guard.

No behavior changes elsewhere; the X close button on the Sheet is untouched. Desktop and mobile both benefit (menu makes the destructive action a deliberate two-tap action).

### Files
- `src/components/folders/FolderEditor.tsx` — swap trash button for DropdownMenu; add `MoreVertical` to lucide imports; add `DropdownMenu*` imports from `@/components/ui/dropdown-menu`.
