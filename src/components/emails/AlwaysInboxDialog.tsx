import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { moveEmailToInbox } from "@/lib/gmail.functions";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { AtSign, Globe } from "lucide-react";
import { useState } from "react";

export function AlwaysInboxDialog({
  open,
  onOpenChange,
  emailId,
  fromAddr,
  domain,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  emailId: string;
  fromAddr: string | null;
  domain: string | null;
}) {
  const qc = useQueryClient();
  const moveFn = useServerFn(moveEmailToInbox);
  const [busy, setBusy] = useState<"email" | "domain" | null>(null);

  async function add(kind: "email" | "domain") {
    setBusy(kind);
    try {
      await moveFn({ data: { email_id: emailId, add_override: kind } });
      qc.invalidateQueries({ queryKey: ["inbox-overrides"] });
      toast.success(
        kind === "email"
          ? `Future mail from ${fromAddr} will go to inbox`
          : `Future mail from ${domain} will go to inbox`,
      );
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Always send to inbox?</DialogTitle>
          <DialogDescription>
            This message is back in your inbox. Want future mail from this sender to skip folder rules and AI too?
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {fromAddr && (
            <Button
              variant="outline"
              className="w-full justify-start"
              disabled={!!busy}
              onClick={() => add("email")}
            >
              <AtSign className="mr-2 h-4 w-4" />
              <span className="truncate">Just {fromAddr}</span>
            </Button>
          )}
          {domain && (
            <Button
              variant="outline"
              className="w-full justify-start"
              disabled={!!busy}
              onClick={() => add("domain")}
            >
              <Globe className="mr-2 h-4 w-4" />
              <span className="truncate">Anyone @{domain}</span>
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!!busy}>
            No thanks
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
