import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { FolderEditor, type Folder, type GLabel } from "./FolderEditor";

export function EditFolderDialog({
  folder,
  labels,
  open,
  onOpenChange,
}: {
  folder: Folder | null;
  labels: GLabel[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Edit folder</SheetTitle>
        </SheetHeader>
        {folder && (
          <div className="mt-4">
            <FolderEditor folder={folder} labels={labels} onDeleted={() => onOpenChange(false)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
