import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createGmailLabel } from "@/lib/gmail.functions";
import { createFolder } from "@/lib/gmail/folder-mgmt.functions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Check, Filter, Sparkles, RotateCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import type { GLabel } from "./FolderEditor";

const NEW_LABEL = "__new__";
const NO_LABEL = "__no_label__";
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

/** Toggle chip for the "when mail lands here" folder actions. */
function ActionChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs transition-colors ${
        active
          ? "border-primary text-primary"
          : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground"
      }`}
    >
      {active && <Check className="h-3 w-3" />}
      {label}
    </button>
  );
}

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
  const createFolderFn = useServerFn(createFolder);
  // Auto-learn on create was intentionally removed. New folders stay
  // inert (no ingestion, no mirroring) unless the user gives them intent
  // here — a plain-English description activates AI sorting; otherwise
  // they opt in later via "Re-learn" or the folder editor.
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(pickColor);
  const [description, setDescription] = useState("");
  const [skipInbox, setSkipInbox] = useState(false);
  const [markRead, setMarkRead] = useState(false);
  const [star, setStar] = useState(false);
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

  function resetForm() {
    setName("");
    setColor(pickColor());
    setDescription("");
    setSkipInbox(false);
    setMarkRead(false);
    setStar(false);
    setLabelChoice(NEW_LABEL);
    setParentLabelId("");
  }

  async function submit() {
    if (!name.trim() || !accountId) return;
    setBusy(true);
    try {
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
      } else if (labelChoice !== NO_LABEL) {
        labelId = labelChoice;
      }
      let folderId: string;
      try {
        const created = await createFolderFn({
          data: {
            account_id: accountId,
            name: name.trim(),
            color,
            gmail_label_id: labelId,
          },
        });
        folderId = created.id;
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to create folder");
        return;
      }
      // Apply the optional intent gathered here (description = AI rule,
      // landing actions) with the same RLS-scoped update the folder
      // editor uses. A description activates AI sorting (skip_ai=false),
      // mirroring the editor's auto-activate behavior.
      const desc = description.trim();
      const patch: Record<string, unknown> = {};
      if (desc) {
        patch.ai_rule = desc.slice(0, 2000);
        patch.skip_ai = false;
      }
      if (skipInbox) patch.auto_archive = true;
      if (markRead) patch.auto_mark_read = true;
      if (star) patch.auto_star = true;
      if (Object.keys(patch).length > 0) {
        const { error } = await supabase
          .from("folders")
          .update(patch as never)
          .eq("id", folderId);
        if (error) {
          toast.warning(
            "Folder created, but its settings couldn't be saved. Edit the folder to retry.",
          );
        }
      }
      resetForm();
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      onOpenChange(false);
      toast.success(
        desc
          ? "Folder created — AI will start sorting new mail. Use Re-learn to pull existing matches."
          : labelId
            ? "Folder created. Open it and click Re-learn to pull matching Gmail messages."
            : "Folder created.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0">
        <div className="flex max-h-[85vh] flex-col md:flex-row">
          {/* Form */}
          <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
            <DialogHeader className="space-y-0">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">
                New folder
              </span>
              <DialogTitle asChild>
                <Input
                  autoFocus
                  placeholder="Folder name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  className="mt-0.5 h-auto border-none bg-transparent px-0 font-display text-2xl shadow-none focus-visible:ring-0"
                />
              </DialogTitle>
            </DialogHeader>

            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Folder color">
              {palette.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  role="radio"
                  aria-checked={color === hex}
                  aria-label={`Color ${hex}`}
                  onClick={() => setColor(hex)}
                  className="h-[22px] w-[22px] rounded-full transition-shadow"
                  style={{
                    background: hex,
                    boxShadow:
                      color === hex ? `0 0 0 2px hsl(var(--background)), 0 0 0 4px ${hex}` : "none",
                  }}
                />
              ))}
            </div>

            <div>
              <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                What belongs here?
              </label>
              <Textarea
                rows={3}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Recruiter emails, interview scheduling, and offers — from agencies or in-house talent teams."
                className="mt-1.5"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Plain English. The AI uses this to sort mail that no deterministic rule catches —
                leave it empty to keep the folder manual for now.
              </p>
            </div>

            <div>
              <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Gmail label
              </label>
              <div className="mt-1.5 space-y-2">
                <Select value={labelChoice} onValueChange={setLabelChoice}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEW_LABEL}>Mirror to a new Gmail label</SelectItem>
                    <SelectItem value={NO_LABEL}>No Gmail label</SelectItem>
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
            </div>

            <div>
              <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                When mail lands here
              </label>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <ActionChip
                  label="Skip inbox"
                  active={skipInbox}
                  onToggle={() => setSkipInbox((v) => !v)}
                />
                <ActionChip
                  label="Mark read"
                  active={markRead}
                  onToggle={() => setMarkRead((v) => !v)}
                />
                <ActionChip label="Star" active={star} onToggle={() => setStar((v) => !v)} />
              </div>
            </div>

            <div className="mt-auto flex justify-end gap-2 border-t border-border pt-4">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={busy || !name.trim() || !accountId}>
                {busy ? "Creating…" : "Create folder"}
              </Button>
            </div>
          </div>

          {/* How sorting works */}
          <div className="w-full shrink-0 border-t border-border bg-background/60 md:w-[300px] md:border-l md:border-t-0">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-green-400">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" aria-hidden />
                How sorting works
              </span>
            </div>
            <div className="flex flex-col gap-2.5 p-4 text-xs leading-relaxed text-muted-foreground">
              <div className="rounded-sm border border-border bg-card/60 p-3">
                <span className="flex items-center gap-1.5 text-foreground">
                  <Filter className="h-3.5 w-3.5 text-[#6bd1e0]" /> Rules run first
                </span>
                <p className="mt-1">
                  Add deterministic rules (domain, subject, sender) any time in the folder editor —
                  they always win over AI.
                </p>
              </div>
              <div className="rounded-sm border border-primary/25 bg-primary/5 p-3">
                <span className="flex items-center gap-1.5 text-foreground">
                  <Sparkles className="h-3.5 w-3.5 text-primary" /> AI reads your description
                </span>
                <p className="mt-1">
                  Anything the rules don't catch is matched against “what belongs here” — and the
                  folder learns from every email you move.
                </p>
              </div>
              <div className="rounded-sm border border-border bg-card/60 p-3">
                <span className="flex items-center gap-1.5 text-foreground">
                  <RotateCw className="h-3.5 w-3.5 text-amber-400" /> Re-learn pulls history
                </span>
                <p className="mt-1">
                  New folders only sort mail that arrives from now on. Open the folder and hit
                  Re-learn to file existing messages too.
                </p>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
