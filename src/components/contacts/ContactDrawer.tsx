import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
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
import { ContactDetailView, type ContactEditorFlush } from "./ContactDetailView";

type Props = {
  contactId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
};

export function ContactDrawer({ contactId, open, onOpenChange }: Props) {
  // Edits autosave as you type, so closing normally just flushes any pending
  // save. The discard dialog only appears when flushing is NOT safe — an
  // invalid (half-typed) email/phone row is blocking autosave.
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const flushRef = useRef<ContactEditorFlush | null>(null);
  const handleDirtyChange = useCallback((d: boolean) => setDirty(d), []);

  function close() {
    setDirty(false);
    onOpenChange(false);
  }

  function handleOpenChange(v: boolean) {
    if (v) {
      onOpenChange(v);
      return;
    }
    if (!dirty) {
      close();
      return;
    }
    const flush = flushRef.current;
    if (!flush) {
      setConfirmDiscard(true);
      return;
    }
    void flush().then((result) => {
      if (result === "invalid") {
        setConfirmDiscard(true);
      } else {
        if (result === "error") {
          toast.error("Couldn't save your latest edits — they may not have been stored.");
        }
        close();
      }
    });
  }

  return (
    <>
      <Sheet open={open} onOpenChange={handleOpenChange}>
        <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-2xl">
          {contactId && (
            <div className="mt-2">
              <ContactDetailView
                id={contactId}
                onDeleted={close}
                onDirtyChange={handleDirtyChange}
                flushRef={flushRef}
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
              An email or phone entry is incomplete, so your latest edits couldn't be autosaved.
              Closing now will throw them away.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setConfirmDiscard(false);
                close();
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
