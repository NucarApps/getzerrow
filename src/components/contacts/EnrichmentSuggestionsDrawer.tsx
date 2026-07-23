import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, RotateCcw, Sparkles, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useEffect, useRef, useState } from "react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getContactAiScanStatus } from "@/lib/contacts/ai-scan-status.functions";
import {
  applyContactEnrichmentSuggestion,
  dismissContactEnrichmentSuggestion,
  listContactEnrichmentSuggestions,
  scanContactEnrichment,
  undismissContactEnrichmentSuggestion,
} from "@/lib/contacts/enrich-suggest.functions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Tab = "pending" | "dismissed";

const confidenceStyles: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-300",
  medium: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-slate-100 text-slate-700 border-slate-300",
};

const fieldLabels: Record<string, string> = {
  email: "Email",
  phone: "Phone",
  company: "Company",
  title: "Title",
  name: "Name",
};

export function EnrichmentSuggestionsDrawer({ open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const list = useServerFn(listContactEnrichmentSuggestions);
  const scan = useServerFn(scanContactEnrichment);
  const apply = useServerFn(applyContactEnrichmentSuggestion);
  const dismiss = useServerFn(dismissContactEnrichmentSuggestion);
  const undismiss = useServerFn(undismissContactEnrichmentSuggestion);

  const [tab, setTab] = useState<Tab>("pending");

  const query = useQuery({
    queryKey: ["contact-enrichment-suggestions", tab],
    queryFn: () => list({ data: { status: tab } }),
    enabled: open,
  });

  const invalidateBoth = () => {
    void qc.invalidateQueries({ queryKey: ["contact-enrichment-suggestions"] });
  };

  // Scans run in the background worker (up to 40 signature extractions per
  // run) — poll job status while one is active and refresh when it lands.
  const scanStatus = useServerFn(getContactAiScanStatus);
  const statusQ = useQuery({
    queryKey: ["contact-ai-scan", "signature_scan"],
    queryFn: () => scanStatus({ data: { kind: "signature_scan" } }),
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
      invalidateBoth();
      if (job?.status === "done") toast.success("Inbox enrichment scan finished");
      if (job?.status === "failed")
        toast.error(`Enrichment scan failed: ${job.error ?? "unknown"}`);
    }
    prevActiveRef.current = scanActive;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanActive, job?.status, job?.error]);

  const scanMutation = useMutation({
    mutationFn: () => scan({ data: { strictness: 3 } }),
    onSuccess: (res) => {
      toast.message(
        res.alreadyQueued
          ? "An enrichment scan is already running — results will appear here."
          : "Enrichment scan queued — suggestions appear here as signatures are read (usually within ~2 minutes).",
      );
      void qc.invalidateQueries({ queryKey: ["contact-ai-scan", "signature_scan"] });
    },
    onError: (err: Error) => toast.error(err.message || "Scan failed"),
  });

  const applyMutation = useMutation({
    mutationFn: (id: string) => apply({ data: { suggestionId: id } }),
    onSuccess: () => {
      toast.success("Applied");
      invalidateBoth();
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (err: Error) => toast.error(err.message || "Apply failed"),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => dismiss({ data: { suggestionId: id } }),
    onSuccess: () => invalidateBoth(),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => undismiss({ data: { suggestionId: id } }),
    onSuccess: () => {
      toast.success("Restored to pending");
      invalidateBoth();
    },
    onError: (err: Error) => toast.error(err.message || "Restore failed"),
  });

  const groups = query.data ?? [];
  const isDismissed = tab === "dismissed";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" /> Enrich contacts
          </SheetTitle>
          <SheetDescription>
            Reads recent messages from each contact to extract company, title, and phone from email
            signatures. Dismissed items are remembered so they won't be suggested again.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex items-center justify-between gap-2">
          <Button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending || scanActive}
            size="sm"
          >
            {scanMutation.isPending || scanActive ? (
              <Spinner className="h-4 w-4 mr-2" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            {scanActive ? "Scanning…" : groups.length > 0 ? "Rescan" : "Run enrichment scan"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {groups.length} contact{groups.length === 1 ? "" : "s"}
          </span>
        </div>

        {scanActive && (
          <p className="mt-3 rounded-md border border-border bg-accent/30 px-3 py-2 text-xs text-muted-foreground">
            A background scan is reading signatures — suggestions appear below as they're found. You
            can close this drawer; the scan keeps going.
          </p>
        )}
        {job?.status === "failed" && !scanActive && (
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            The last scan failed{job.error ? `: ${job.error}` : ""}. Run it again to retry.
          </p>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-4">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="mt-4 space-y-3">
          {query.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : query.isError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              Couldn&apos;t load suggestions
              {query.error instanceof Error ? `: ${query.error.message}` : ""}. Try running the scan
              again.
            </div>
          ) : groups.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {isDismissed
                ? "No dismissed suggestions yet."
                : "No pending suggestions. Run a scan to look for enrichments across your contacts."}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.contact.id} className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">
                      {g.contact.name || g.contact.email || "Unnamed contact"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {g.contact.email || "no email"}
                      {g.contact.company ? ` · ${g.contact.company}` : ""}
                    </div>
                  </div>
                </div>
                <ul className="space-y-1.5">
                  {g.suggestions.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                            {fieldLabels[s.field] ?? s.field}
                          </span>
                          <Badge
                            variant="outline"
                            className={`text-[10px] px-1.5 py-0 ${confidenceStyles[s.confidence] ?? ""}`}
                          >
                            {s.confidence}
                          </Badge>
                        </div>
                        <div className="truncate">{s.value}</div>
                        {s.evidence ? (
                          <div className="text-xs text-muted-foreground truncate">{s.evidence}</div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {isDismissed ? (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() => restoreMutation.mutate(s.id)}
                            disabled={restoreMutation.isPending}
                            title="Restore to pending"
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => applyMutation.mutate(s.id)}
                              disabled={applyMutation.isPending}
                              title="Apply"
                            >
                              <Check className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => dismissMutation.mutate(s.id)}
                              disabled={dismissMutation.isPending}
                              title="Dismiss"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
