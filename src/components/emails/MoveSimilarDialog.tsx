import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { findSimilarEmails, bulkMoveEmails } from "@/lib/gmail.functions";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { Loader2, AtSign, Globe } from "lucide-react";

type Folder = { id: string; name: string; color: string };
type Match = {
  id: string; subject: string | null; from_addr: string | null;
  from_name: string | null; received_at: string | null; snippet: string | null;
};

export function MoveSimilarDialog({
  open,
  onOpenChange,
  emailId,
  fromFolderId,
  fromAddr,
  domain,
  toFolder,
  folders,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  emailId: string;
  fromFolderId: string | null;
  fromAddr: string | null;
  domain: string | null;
  toFolder: Folder;
  folders: Folder[];
}) {
  const qc = useQueryClient();
  const findFn = useServerFn(findSimilarEmails);
  const moveFn = useServerFn(bulkMoveEmails);

  const [mode, setMode] = useState<"sender" | "domain">("sender");
  const [matches, setMatches] = useState<Match[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);

  const fromFolderName = useMemo(
    () => folders.find((f) => f.id === fromFolderId)?.name ?? "No rules",
    [folders, fromFolderId],
  );

  useEffect(() => {
    if (!open) return;
    setMode("sender");
  }, [open, emailId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    findFn({ data: { email_id: emailId, from_folder_id: fromFolderId, mode } })
      .then((r) => {
        if (cancelled) return;
        setMatches(r.matches);
        setSelected(new Set(r.matches.map((m) => m.id)));
      })
      .catch((e: any) => !cancelled && toast.error(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [open, emailId, fromFolderId, mode, findFn]);

  const allSelected = matches.length > 0 && selected.size === matches.length;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }
  function toggleAll() {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(matches.map((m) => m.id)));
  }

  async function confirmMove() {
    if (selected.size === 0) return;
    setMoving(true);
    try {
      const create_rule =
        mode === "domain" && domain
          ? { field: "domain" as const, value: domain }
          : mode === "sender" && fromAddr
          ? { field: "from" as const, value: fromAddr }
          : null;
      const r = await moveFn({
        data: { email_ids: Array.from(selected), to_folder_id: toFolder.id, create_rule },
      });
      toast.success(
        `Moved ${r.moved} to ${toFolder.name}${r.failed ? ` · ${r.failed} failed` : ""}${
          create_rule ? " · rule saved" : ""
        }`,
      );
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["emails-summary"] });
      qc.invalidateQueries({ queryKey: ["folder-filters"] });
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setMoving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Move similar emails to {toFolder.name}?</DialogTitle>
          <DialogDescription>
            Other emails in <span className="font-medium text-foreground">{fromFolderName}</span> that match.
            Uncheck any you want to keep.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setMode("sender")}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${mode === "sender" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
          >
            <AtSign className="h-3 w-3" />
            Same sender{fromAddr ? ` · ${fromAddr}` : ""}
          </button>
          <button
            onClick={() => setMode("domain")}
            disabled={!domain}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs disabled:opacity-40 ${mode === "domain" ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
          >
            <Globe className="h-3 w-3" />
            Same domain{domain ? ` · @${domain}` : ""}
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Finding similar…
            </div>
          ) : matches.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No other matching emails in {fromFolderName}.
            </div>
          ) : (
            <>
              <label className="flex items-center gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                <span>{selected.size} of {matches.length} selected</span>
              </label>
              <ul className="divide-y divide-border">
                {matches.map((m) => (
                  <li key={m.id}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-accent/40">
                      <Checkbox
                        checked={selected.has(m.id)}
                        onCheckedChange={() => toggle(m.id)}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {m.from_name || m.from_addr || "Unknown"}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {m.received_at
                              ? formatDistanceToNow(new Date(m.received_at), { addSuffix: false })
                              : ""}
                          </span>
                        </div>
                        <div className="truncate text-sm text-foreground/90">
                          {m.subject || "(no subject)"}
                        </div>
                        {m.snippet && (
                          <div className="line-clamp-1 text-xs text-muted-foreground">{m.snippet}</div>
                        )}
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {matches.length >= 50 && (
          <p className="text-xs text-muted-foreground">
            Showing the 50 most recent matches.
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={moving}>
            Not now
          </Button>
          <Button
            onClick={confirmMove}
            disabled={moving || selected.size === 0}
          >
            {moving ? "Moving…" : `Move ${selected.size} to ${toFolder.name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
