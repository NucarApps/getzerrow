import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createGmailLabel, learnFolderFromLabel } from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import type { GLabel } from "./FolderEditor";

const NEW_LABEL = "__new__";
const palette = ["#f59e0b", "#10b981", "#3b82f6", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6", "#eab308"];
const pickColor = () => palette[Math.floor(Math.random() * palette.length)];

export function AddFolderDialog({
  open,
  onOpenChange,
  accountId,
  labels,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string | null;
  labels: GLabel[];
}) {
  const qc = useQueryClient();
  const createLabel = useServerFn(createGmailLabel);
  const learnFn = useServerFn(learnFolderFromLabel);
  const [name, setName] = useState("");
  const [labelChoice, setLabelChoice] = useState<string>(NEW_LABEL);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim() || !accountId) return;
    setBusy(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user!.id;
      let labelId: string | null = null;
      if (labelChoice === NEW_LABEL) {
        try {
          const r = await createLabel({ data: { account_id: accountId, name: name.trim() } });
          labelId = r.id;
        } catch {
          toast.warning("Couldn't create Gmail label. Folder created locally.");
        }
      } else {
        labelId = labelChoice;
      }
      const { error } = await supabase.from("folders").insert({
        name: name.trim(),
        user_id: userId,
        gmail_account_id: accountId,
        gmail_label_id: labelId,
        color: pickColor(),
      });
      if (error) { toast.error(error.message); return; }
      setName("");
      setLabelChoice(NEW_LABEL);
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>New folder</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input autoFocus placeholder="Folder name (e.g. Newsletters)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <Select value={labelChoice} onValueChange={setLabelChoice}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_LABEL}>Create new Gmail label</SelectItem>
              {labels.map((l) => (
                <SelectItem key={l.id} value={l.id}>Link to: {l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !accountId}>Add folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
