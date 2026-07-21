import { useCallback, useState } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ContactDetailView } from "./ContactDetailView";

type Props = {
  contactId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
};

export function ContactDrawer({ contactId, open, onOpenChange }: Props) {
  // Guard against silently discarding unsaved edits: the detail view reports
  // its dirty state, and a close attempt while dirty asks first.
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const handleDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  function handleOpenChange(v: boolean) {
    if (!v && dirty) {
      setConfirmDiscard(true);
      return;
    }
    if (!v) setDirty(false);
    onOpenChange(v);
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-2xl">
          {contactId && (
            <div className="mt-2">
              <ContactDetailView
                id={contactId}
                onDeleted={() => {
                  setDirty(false);
                  onOpenChange(false);
                }}
                onDirtyChange={handleDirtyChange}
              />
            </div>
          )}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have edits that haven't been saved. Closing now will throw them away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmDiscard(false);
                setDirty(false);
                onOpenChange(false);
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
