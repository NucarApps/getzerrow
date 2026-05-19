Swap the Edit folder modal for a right-side drawer using the existing shadcn `Sheet` component.

**Change**: `src/components/folders/EditFolderDialog.tsx` — replace `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle` with `Sheet`/`SheetContent side="right"`/`SheetHeader`/`SheetTitle`. Keep the same props and the `FolderEditor` body; widen `SheetContent` (e.g. `sm:max-w-xl w-full`) and make it scrollable.

No changes to `FolderEditor`, `AddFolderDialog`, or the sidebar trigger logic. Add-folder stays a dialog unless you want that to be a drawer too — let me know.