Replace the hover three-dots dropdown on each folder row with a single pencil button that opens the edit drawer directly.

**Change**: `src/routes/_authenticated.tsx` — swap the `DropdownMenu`/`DropdownMenuTrigger`/`DropdownMenuContent`/`DropdownMenuItem` block (lines ~238-253) for a plain `<button>` containing the existing `Pencil` icon, with the same hover-reveal styling (`opacity-0 group-hover:opacity-100`) and `onClick={(e) => { e.stopPropagation(); onEdit(); }}`. Drop the now-unused `MoreHorizontal` import and the four `DropdownMenu*` imports.

No changes to `EditFolderDialog`, `FolderEditor`, or any other file.