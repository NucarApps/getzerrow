import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef } from "react";
import { Loader2, Merge, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  dismissContactDuplicate,
  listContactDuplicateSuggestions,
  mergeContactDuplicate,
  scanContactDuplicates,
} from "@/lib/contacts/dedup.functions";
import { getContactAiScanStatus } from "@/lib/contacts/ai-scan-status.functions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const confidenceStyles: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-300",
  medium: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-slate-100 text-slate-700 border-slate-300",
};

export function DuplicateSuggestionsDrawer({ open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const list = useServerFn(listContactDuplicateSuggestions);
  const scan = useServerFn(scanContactDuplicates);
  const doMerge = useServerFn(mergeContactDuplicate);
  const doDismiss = useServerFn(dismissContactDuplicate);

  const scanStatus = useServerFn(getContactAiScanStatus);

  const query = useQuery({
    queryKey: ["contact-duplicate-suggestions"],
    queryFn: () => list(),
    enabled: open,
  });

  // Scans run in the background worker (they take up to ~10 model calls) —
  // poll the job status while one is queued/running and refresh the list
  // when it finishes.
  const statusQ = useQuery({
    queryKey: ["contact-ai-scan", "dedup_scan"],
    queryFn: () => scanStatus({ data: { kind: "dedup_scan" } }),
    enabled: open,
    refetchInterval: (q) => {
      const s = q.state.data?.job?.status;
      return s === "pending" || s === "running" ? 4_000 : false;
    },
  });
  const job = statusQ.data?.job ?? null;
  const scanActive = job?.status === "pending" || job?.status === "running";
  const prevActiveRef = useRef(false);
  useEffect(() => {
    if (prevActiveRef.current && !scanActive) {
      void qc.invalidateQueries({ queryKey: ["contact-duplicate-suggestions"] });
      if (job?.status === "done") toast.success("Duplicate scan finished");
      if (job?.status === "failed") toast.error(`Duplicate scan failed: ${job.error ?? "unknown"}`);
    }
    prevActiveRef.current = scanActive;
  }, [scanActive, job?.status, job?.error, qc]);

  const scanMutation = useMutation({
    mutationFn: () => scan(),
    onSuccess: (res) => {
      toast.message(
        res.alreadyQueued
          ? "A duplicate scan is already running — results will appear here."
          : "Duplicate scan queued — results appear here as clusters are judged (usually within ~2 minutes).",
      );
      void qc.invalidateQueries({ queryKey: ["contact-ai-scan", "dedup_scan"] });
    },
    onError: (err: Error) => toast.error(err.message || "Scan failed"),
  });

  const mergeMutation = useMutation({
    mutationFn: (suggestionId: string) => doMerge({ data: { suggestionId } }),
    onSuccess: (res) => {
      toast.success(`Merged ${res.merged} duplicate${res.merged === 1 ? "" : "s"}`);
      void qc.invalidateQueries({ queryKey: ["contact-duplicate-suggestions"] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (err: Error) => toast.error(err.message || "Merge failed"),
  });

  const dismissMutation = useMutation({
    mutationFn: (suggestionId: string) => doDismiss({ data: { suggestionId } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact-duplicate-suggestions"] });
    },
    onError: (err: Error) => toast.error(err.message || "Dismiss failed"),
  });

  const suggestions = query.data?.suggestions ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Duplicate contacts
          </SheetTitle>
          <SheetDescription>
            AI-assisted review of contacts that look like the same person. Phone-match clusters are
            auto-marked high confidence.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending || scanActive}
          >
            {scanMutation.isPending || scanActive ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            {scanActive ? "Scanning…" : "Run duplicate scan"}
          </Button>
          {query.isFetching && !query.isLoading && (
            <span className="text-xs text-muted-foreground">Refreshing…</span>
          )}
        </div>

        {scanActive && (
          <p className="mt-3 rounded-md border border-border bg-accent/30 px-3 py-2 text-xs text-muted-foreground">
            A background scan is running — suggestions appear below as clusters are judged. You can
            close this drawer; the scan keeps going.
          </p>
        )}
        {job?.status === "failed" && !scanActive && (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            The last scan failed{job.error ? `: ${job.error}` : ""}. Run it again to retry.
          </p>
        )}

        <div className="mt-4 space-y-3">
          {query.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : query.isError ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 py-8 text-center text-sm text-destructive">
              Couldn&apos;t load duplicate suggestions
              {query.error instanceof Error ? `: ${query.error.message}` : ""}. Try running the scan
              again.
            </p>
          ) : suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No pending duplicate suggestions. Run a scan to look for new ones.
            </p>
          ) : (
            suggestions.map((s) => {
              const primary = s.contacts.find((c) => c.id === s.primary_contact_id);
              const dups = s.contacts.filter((c) => c.id !== s.primary_contact_id);
              return (
                <div key={s.id} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant="outline" className={confidenceStyles[s.confidence] ?? ""}>
                      {s.confidence} confidence
                    </Badge>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => dismissMutation.mutate(s.id)}
                        disabled={dismissMutation.isPending}
                        title="Not a duplicate"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => mergeMutation.mutate(s.id)}
                        disabled={mergeMutation.isPending}
                      >
                        <Merge className="h-4 w-4 mr-1" /> Merge
                      </Button>
                    </div>
                  </div>
                  {s.reason && <p className="text-xs text-muted-foreground italic">{s.reason}</p>}
                  <div className="text-sm">
                    <div className="font-medium">
                      Keep: {primary?.name ?? "Unnamed"}
                      {primary?.email && (
                        <span className="text-muted-foreground font-normal ml-1">
                          · {primary.email}
                        </span>
                      )}
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {dups.map((c) => (
                        <li key={c.id}>
                          Merge in: {c.name ?? "Unnamed"}
                          {c.email && <> · {c.email}</>}
                          {c.company && <> · {c.company}</>}
                          {c.phones[0] && <> · {c.phones[0]}</>}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
