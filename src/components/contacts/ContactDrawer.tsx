import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ContactDetailView } from "./ContactDetailView";

type Props = {
  contactId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
};

export function ContactDrawer({ contactId, open, onOpenChange }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-2xl">
        {contactId && (
          <div className="mt-2">
            <ContactDetailView id={contactId} onDeleted={() => onOpenChange(false)} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
