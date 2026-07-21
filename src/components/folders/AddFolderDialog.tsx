import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createGmailLabel, learnFolderFromLabel } from "@/lib/gmail.functions";
import { createFolder } from "@/lib/gmail/folder-mgmt.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import type { GLabel } from "./FolderEditor";

const NEW_LABEL = "__new__";
const palette = [
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#ec4899",
  "#8b5cf6",
  "#ef4444",
  "#14b8a6",
  "#eab308",
];
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
  const [parentLabelId, setParentLabelId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const NONE = "__none__";
  const zerrowLabels = labels
    .filter((l) => l.name === "Zerrow" || l.name.startsWith("Zerrow/"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const labelPath = (n: string) => {
    const parts = n.split("/");
    return parts.length === 1 ? "Zerrow (root)" : parts.slice(1).join(" / ");
  };

  async function submit() {
    if (!name.trim() || !accountId) return;
    setBusy(true);
    try {
      const userId = (await supabase.auth.getUser()).data.user!.id;
      let labelId: string | null = null;
      if (labelChoice === NEW_LABEL) {
        try {
          const r = await createLabel({
            data: {
              account_id: accountId,
              name: name.trim(),
              ...(parentLabelId && parentLabelId !== NONE
                ? { parent_label_id: parentLabelId }
                : {}),
            },
          });
          labelId = r.id;
        } catch {
          toast.warning("Couldn't create Gmail label. Folder created locally.");
        }
      } else {
        labelId = labelChoice;
      }
      const { data: inserted, error } = await supabase
        .from("folders")
        .insert({
          name: name.trim(),
          user_id: userId,
          gmail_account_id: accountId,
          gmail_label_id: labelId,
          color: pickColor(),
        })
        .select("id")
        .single();
      if (error) {
        toast.error(error.message);
        return;
      }
      setName("");
      setLabelChoice(NEW_LABEL);
      setParentLabelId("");
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      onOpenChange(false);
      if (labelId && inserted?.id) {
        toast.message("Pulling emails from Gmail…");
        try {
          const r = await learnFn({ data: { folder_id: inserted.id } });
          const pulled = (r?.claimed ?? 0) + (r?.ingested ?? 0);
          toast.success(
            `Folder created. Linked ${pulled} email${pulled === 1 ? "" : "s"} from Gmail.`,
          );
        } catch (e: unknown) {
          toast.warning(
            `Folder created. Couldn't pull from Gmail: ${e instanceof Error ? e.message : "error"}`,
          );
        }
        qc.invalidateQueries({ queryKey: ["emails"] });
        qc.invalidateQueries({ queryKey: ["emails-summary"] });
      } else {
        toast.success("Folder created.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New folder</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            autoFocus
            placeholder="Folder name (e.g. Newsletters)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <Select value={labelChoice} onValueChange={setLabelChoice}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_LABEL}>Create new Gmail label</SelectItem>
              {labels.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  Link to: {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {labelChoice === NEW_LABEL && (
            <Select
              value={parentLabelId || NONE}
              onValueChange={(v) => setParentLabelId(v === NONE ? "" : v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Parent label (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None (top level)</SelectItem>
                {zerrowLabels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    Under: {labelPath(l.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim() || !accountId}>
            Add folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
