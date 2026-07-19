import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FolderEditor, type Folder, type GLabel } from "./FolderEditor";

export function EditFolderDialog({
  folder,
  labels,
  open,
  onOpenChange,
  onDeleted,
}: {
  folder: Folder | null;
  labels: GLabel[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Extra hook for callers that need to react when the folder is deleted (the sheet always closes). */
  onDeleted?: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Edit folder</SheetTitle>
        </SheetHeader>
        {folder && (
          <div className="mt-4">
            <FolderEditor
              folder={folder}
              labels={labels}
              onDeleted={() => {
                onOpenChange(false);
                onDeleted?.();
              }}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
