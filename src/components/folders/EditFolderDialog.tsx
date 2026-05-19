import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Edit folder</DialogTitle></DialogHeader>
        {folder && (
          <FolderEditor
            folder={folder}
            labels={labels}
            onDeleted={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
