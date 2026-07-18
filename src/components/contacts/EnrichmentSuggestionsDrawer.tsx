import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2, Sparkles, X } from "lucide-react";
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
  applyContactEnrichmentSuggestion,
  dismissContactEnrichmentSuggestion,
  listContactEnrichmentSuggestions,
  scanContactEnrichment,
} from "@/lib/contacts/enrich-suggest.functions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

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
};

export function EnrichmentSuggestionsDrawer({ open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const list = useServerFn(listContactEnrichmentSuggestions);
  const scan = useServerFn(scanContactEnrichment);
  const apply = useServerFn(applyContactEnrichmentSuggestion);
  const dismiss = useServerFn(dismissContactEnrichmentSuggestion);

  const query = useQuery({
    queryKey: ["contact-enrichment-suggestions"],
    queryFn: () => list(),
    enabled: open,
  });

  const scanMutation = useMutation({
    mutationFn: () => scan({ data: { strictness: 3 } }),
    onSuccess: (res) => {
      if (res.created === 0) {
        toast(`Scanned ${res.scanned} contacts — no new suggestions`);
      } else {
        toast.success(
          `Scanned ${res.scanned} contacts — ${res.created} new suggestion${res.created === 1 ? "" : "s"}`,
        );
      }
      void qc.invalidateQueries({ queryKey: ["contact-enrichment-suggestions"] });
    },
    onError: (err: Error) => toast.error(err.message || "Scan failed"),
  });

  const applyMutation = useMutation({
    mutationFn: (id: string) => apply({ data: { suggestionId: id } }),
    onSuccess: () => {
      toast.success("Applied");
      void qc.invalidateQueries({ queryKey: ["contact-enrichment-suggestions"] });
      void qc.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (err: Error) => toast.error(err.message || "Apply failed"),
  });

  const dismissMutation = useMutation({
    mutationFn: (id: string) => dismiss({ data: { suggestionId: id } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contact-enrichment-suggestions"] });
    },
  });

  const groups = query.data ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" /> Enrich contacts
          </SheetTitle>
          <SheetDescription>
            Find missing emails, phone numbers, companies, and titles by looking at your inbox.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 flex items-center justify-between gap-2">
          <Button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
            size="sm"
          >
            {scanMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-2" />
            )}
            {groups.length > 0 ? "Rescan" : "Run enrichment scan"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {groups.length} contact{groups.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {query.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : groups.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              No pending suggestions. Run a scan to look for enrichments across your contacts.
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
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
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
                          <div className="text-xs text-muted-foreground truncate">
                            {s.evidence}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
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
