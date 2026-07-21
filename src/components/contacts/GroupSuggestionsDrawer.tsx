import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Sparkles, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  applyContactGroupSuggestion,
  dismissContactGroupSuggestion,
  getContactGroupSuggestions,
  runContactGroupSuggestions,
} from "@/lib/contacts/suggest-groups.functions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function GroupSuggestionsDrawer({ open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const getSuggestions = useServerFn(getContactGroupSuggestions);
  const runScan = useServerFn(runContactGroupSuggestions);
  const apply = useServerFn(applyContactGroupSuggestion);
  const dismiss = useServerFn(dismissContactGroupSuggestion);

  const q = useQuery({
    queryKey: ["contact-group-suggestions"],
    queryFn: () => getSuggestions(),
    enabled: open,
  });

  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});

  const rescan = useMutation({
    mutationFn: () => runScan(),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["contact-group-suggestions"] });
      const stats = res?.stats;
      if (stats && "cached" in stats && stats.cached) {
        const mins = Math.max(1, Math.round((stats.cachedAgeSeconds ?? 0) / 60));
        toast.message(
          `Showing results from a scan ${mins} min ago — a fresh scan unlocks in ${stats.cooldownRemainingSeconds}s.`,
        );
        return;
      }
      const kept = stats && "kept" in stats ? (stats.kept ?? 0) : 0;
      const pool = stats && "contactPool" in stats ? (stats.contactPool ?? 0) : 0;
      const ungrouped = stats && "ungroupedTotal" in stats ? (stats.ungroupedTotal ?? 0) : 0;
      const topics = stats && "topicsScanned" in stats ? (stats.topicsScanned ?? 0) : 0;
      const topicsSuffix = topics > 0 ? ` · read ${topics} inbox` : "";
      if (kept > 0) {
        toast.success(`Found ${kept} suggestion${kept === 1 ? "" : "s"}${topicsSuffix}`);
      } else {
        toast.message(
          `Scanned ${pool} contacts (${ungrouped} ungrouped)${topicsSuffix} — no new suggestions`,
        );
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: (id: string) =>
      apply({
        data: { id, group_name_override: nameEdits[id] },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["contact-group-suggestions"] });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });
      toast.success(`Added ${res.added} contacts to group`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dismissMut = useMutation({
    mutationFn: (id: string) => dismiss({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-group-suggestions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const suggestions = (q.data?.suggestions ?? []).filter((s) => s.status === "pending");
  const showEmpty = !q.isLoading && !q.isError && !rescan.isPending && suggestions.length === 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI group suggestions
          </SheetTitle>
          <SheetDescription>
            Zerrow reviews your contacts and proposes groups (and subgroups) you can accept with one
            click. Nothing is applied without your confirmation.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            {suggestions.length > 0 ? `${suggestions.length} pending` : "No pending suggestions"}
          </div>
          <Button size="sm" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
            {rescan.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                {suggestions.length > 0 ? "Rescan" : "Run AI scan"}
              </>
            )}
          </Button>
        </div>

        {q.isError && (
          <div className="mt-8 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center text-sm text-destructive">
            Couldn&apos;t load suggestions
            {q.error instanceof Error ? `: ${q.error.message}` : ""}. Try running the scan again.
          </div>
        )}

        {showEmpty && (
          <div className="mt-8 rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            No suggestions yet. Click <strong>Run AI scan</strong> to have Zerrow analyze your
            contacts and propose groups.
          </div>
        )}

        <div className="mt-4 space-y-3">
          {suggestions.map((s) => {
            const editedName = nameEdits[s.id] ?? s.name;
            const kindLabel =
              s.kind === "subgroup"
                ? "Subgroup"
                : s.kind === "merge_into_existing"
                  ? "Add to existing"
                  : "New group";
            return (
              <div key={s.id} className="rounded-lg border border-border bg-card p-4 shadow-sm">
                <div className="mb-2 flex items-center gap-2">
                  <Badge variant="secondary">{kindLabel}</Badge>
                  {s.confidence === "high" && (
                    <Badge variant="outline" className="border-primary/50 text-primary">
                      High confidence
                    </Badge>
                  )}
                  {s.auto_applied && <Badge variant="outline">Applied automatically</Badge>}
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3 w-3" />
                    {s.total_contacts} contacts
                  </div>
                </div>

                {s.kind === "merge_into_existing" ? (
                  <div className="mb-2 text-sm font-medium">{s.name}</div>
                ) : (
                  <Input
                    value={editedName}
                    onChange={(e) => setNameEdits((m) => ({ ...m, [s.id]: e.target.value }))}
                    className="mb-2 h-8 text-sm font-medium"
                  />
                )}

                {s.rationale && <p className="mb-2 text-xs text-muted-foreground">{s.rationale}</p>}

                {s.contact_previews.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1">
                    {s.contact_previews.map((c) => (
                      <span
                        key={c.id}
                        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {c.name || c.email || "Contact"}
                      </span>
                    ))}
                    {s.total_contacts > s.contact_previews.length && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        +{s.total_contacts - s.contact_previews.length} more
                      </span>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => dismissMut.mutate(s.id)}
                    disabled={dismissMut.isPending}
                  >
                    <Trash2 className="mr-1.5 h-4 w-4" /> Dismiss
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => applyMut.mutate(s.id)}
                    disabled={applyMut.isPending}
                  >
                    {s.kind === "merge_into_existing" ? "Add to group" : "Create group"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
