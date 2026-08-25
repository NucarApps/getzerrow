import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ArrowRight, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { applyRuleChangeSet, MAX_APPLIED_MOVES } from "@/lib/rules/planner.functions";
import { autoApplicableIds, describeChangeSet, type ChangeSet } from "@/lib/rules/replay";

/** Review and apply the mail a rule change would move. Nothing moves until
 * the user applies, hand-placed mail can never be selected, and moves out
 * of a confirmed placement are opt-in only. */
export function RuleChangeSetDialog({
  open,
  onOpenChange,
  changeSet,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  changeSet: ChangeSet;
  onApplied?: () => void;
}) {
  const applyFn = useServerFn(applyRuleChangeSet);
  const autoIds = useMemo(() => autoApplicableIds(changeSet), [changeSet]);
  const [selected, setSelected] = useState<string[]>(autoIds);

  useEffect(() => setSelected(autoIds), [autoIds]);

  const movable = changeSet.entries.filter((e) => !e.locked);
  const locked = changeSet.entries.filter((e) => e.locked);
  const byId = new Map(changeSet.entries.map((e) => [e.email_id, e]));

  const apply = useMutation({
    mutationFn: async (ids: string[]) => {
      const batches: string[][] = [];
      for (let i = 0; i < ids.length; i += MAX_APPLIED_MOVES) {
        batches.push(ids.slice(i, i + MAX_APPLIED_MOVES));
      }
      let applied = 0;
      let skipped = 0;
      let failed = 0;
      for (const batch of batches) {
        const res = await applyFn({
          data: {
            moves: batch.map((id) => ({
              email_id: id,
              to_folder_id: byId.get(id)?.to_folder_id ?? null,
            })),
          },
        });
        applied += res.applied;
        skipped += res.skipped;
        failed += res.failed;
      }
      return { applied, skipped, failed };
    },
    onSuccess: (res) => {
      toast.success(
        `Moved ${res.applied} message${res.applied === 1 ? "" : "s"}` +
          (res.skipped ? `, skipped ${res.skipped}` : "") +
          (res.failed ? `, ${res.failed} failed` : ""),
      );
      onApplied?.();
      onOpenChange(false);
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Couldn't apply the changes"),
  });

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review the change</DialogTitle>
          <DialogDescription>
            {describeChangeSet(changeSet)} · scanned {changeSet.scanned} recent message
            {changeSet.scanned === 1 ? "" : "s"}. Nothing moves until you apply.
          </DialogDescription>
        </DialogHeader>

        {changeSet.summary.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {changeSet.summary.map((s) => (
              <Badge key={`${s.from}-${s.to}`} variant="secondary" className="font-normal">
                {s.count} {s.from} <ArrowRight className="mx-1 inline h-3 w-3" /> {s.to}
              </Badge>
            ))}
          </div>
        )}

        {changeSet.requires_review_count > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              {changeSet.requires_review_count} message
              {changeSet.requires_review_count === 1 ? "" : "s"} would move out of a placement you
              confirmed. Those are left unchecked — tick them only if the new rule is right.
            </span>
          </div>
        )}

        <ScrollArea className="max-h-72 rounded-md border border-border">
          <ul className="divide-y divide-border">
            {movable.map((e) => (
              <li key={e.email_id} className="flex items-start gap-2.5 px-3 py-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={selected.includes(e.email_id)}
                  onCheckedChange={() => toggle(e.email_id)}
                  aria-label={`Apply move for ${e.subject ?? "message"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{e.subject || "(no subject)"}</div>
                  <div className="truncate text-xs text-muted-foreground">{e.from_addr}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">{e.from_folder_name}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="font-medium">{e.to_folder_name}</span>
                    {e.requires_review && (
                      <Badge variant="outline" className="h-5 font-normal">
                        Confirmed placement
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{e.reason}</p>
                </div>
              </li>
            ))}
            {locked.map((e) => (
              <li
                key={e.email_id}
                className="flex items-start gap-2.5 px-3 py-2 text-sm opacity-70"
              >
                <Lock className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{e.subject || "(no subject)"}</div>
                  <p className="text-xs text-muted-foreground">{e.reason}</p>
                </div>
              </li>
            ))}
            {changeSet.entries.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-muted-foreground">
                No existing mail changes folders.
              </li>
            )}
          </ul>
        </ScrollArea>

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected(autoIds)}
              disabled={movable.length === 0}
            >
              Select safe ({autoIds.length})
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSelected([])}
              disabled={selected.length === 0}
            >
              Clear
            </Button>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Dismiss
            </Button>
            <Button
              type="button"
              onClick={() => apply.mutate(selected)}
              disabled={selected.length === 0 || apply.isPending}
            >
              {apply.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Apply {selected.length}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
