import { Fragment, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { useScopedAccount } from "@/lib/use-scoped-account";
import { listExecutedRules, type ExecutedRuleRow } from "@/lib/executed-rules.functions";
import { AlertCircle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/_authenticated/settings/rule-activity")({
  head: () => ({
    meta: [{ title: "Rule activity — Settings — Zerrow" }, { name: "robots", content: "noindex" }],
  }),
  component: RuleActivitySettings,
});

const DECIDED_BY_LABELS: Record<string, string> = {
  filter: "Rule",
  domain_rule: "Domain rule",
  gmail_label: "Gmail label",
  ai: "AI",
  ai_low_confidence: "AI (low confidence)",
  ai_error: "AI error",
  inbox_override: "Inbox override",
  surfaced_to_inbox: "Surfaced to inbox",
  excluded: "Excluded by rule",
  calendar_contact: "Calendar guard",
  pending_ai: "Waiting for AI",
  unclassified: "Failed",
  none: "No rule matched",
};

function decidedByLabel(v: string): string {
  return DECIDED_BY_LABELS[v] ?? v;
}

function statusVariant(status: ExecutedRuleRow["status"]) {
  if (status === "error") return "destructive" as const;
  if (status === "applied") return "secondary" as const;
  return "outline" as const;
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function RuleActivitySettings() {
  const { activeAccountId, scopedEmail, onAccountChange } = useScopedAccount();
  const fetchRows = useServerFn(listExecutedRules);
  const [folderId, setFolderId] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const q = useQuery({
    queryKey: ["executed-rules", activeAccountId, folderId],
    queryFn: () =>
      fetchRows({
        data: {
          accountId: activeAccountId ?? undefined,
          folderId: folderId === "all" ? undefined : folderId,
          limit: 500,
        },
      }),
    refetchInterval: 15000,
  });

  const rows = q.data?.rows ?? [];
  const folders = q.data?.folders ?? [];

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <AccountPicker value={activeAccountId} onChange={onAccountChange} label="Inbox" />
      <Card className="overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b bg-muted/20 p-4 md:flex-row md:items-start md:justify-between md:p-6">
          <div>
            <h2 className="font-display text-2xl">Rule activity</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Why each email went where it did in {scopedEmail ?? "the selected mailbox"} — the last
              500 rule and AI decisions.
            </p>
          </div>
          <div className="flex gap-2 self-start md:self-auto">
            <Select value={folderId} onValueChange={setFolderId}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All folders" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All folders</SelectItem>
                {folders.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={`mr-2 h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        <div className="p-4 md:p-6">
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="w-8 p-2"></th>
                  <th className="p-2">When</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Decided by</th>
                  <th className="p-2">Routed to</th>
                  <th className="p-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {q.isLoading && (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                )}
                {!q.isLoading && rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-4 text-center text-muted-foreground">
                      No rule activity yet — decisions appear here as new mail is classified.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const isOpen = expanded.has(r.id);
                  return (
                    <Fragment key={r.id}>
                      <tr
                        className="cursor-pointer border-t hover:bg-muted/30"
                        onClick={() => toggle(r.id)}
                      >
                        <td className="p-2 text-muted-foreground">
                          {isOpen ? (
                            <ChevronDown className="h-3.5 w-3.5" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5" />
                          )}
                        </td>
                        <td className="p-2 whitespace-nowrap" title={r.created_at}>
                          {relTime(r.created_at)}
                        </td>
                        <td className="p-2">
                          <Badge variant={statusVariant(r.status)} className="text-[10px]">
                            {r.status === "error" && <AlertCircle className="mr-1 h-3 w-3" />}
                            {r.status}
                          </Badge>
                        </td>
                        <td className="p-2 whitespace-nowrap">{decidedByLabel(r.classified_by)}</td>
                        <td className="p-2 max-w-[160px] truncate">{r.folder_name ?? "Inbox"}</td>
                        <td className="p-2 max-w-[320px] truncate text-muted-foreground">
                          {r.reason ?? "—"}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t bg-muted/20">
                          <td colSpan={6} className="p-3">
                            <dl className="grid gap-x-6 gap-y-2 text-xs md:grid-cols-[auto_1fr]">
                              <dt className="font-medium text-muted-foreground">Reason</dt>
                              <dd className="whitespace-pre-wrap">{r.reason ?? "—"}</dd>
                              {(r.matched_leaf_json?.length ?? 0) > 0 && (
                                <>
                                  <dt className="font-medium text-muted-foreground">
                                    Matched conditions
                                  </dt>
                                  <dd className="flex flex-wrap gap-1.5">
                                    {r.matched_leaf_json!.map((leaf, i) => (
                                      <Badge key={i} variant="outline" className="font-mono">
                                        {leaf.field} {leaf.op} “{leaf.value}”
                                      </Badge>
                                    ))}
                                  </dd>
                                </>
                              )}
                              {r.ai_confidence != null && r.classified_by.startsWith("ai") && (
                                <>
                                  <dt className="font-medium text-muted-foreground">
                                    AI confidence
                                  </dt>
                                  <dd>{Math.round(r.ai_confidence * 100)}%</dd>
                                </>
                              )}
                              {r.error && (
                                <>
                                  <dt className="font-medium text-muted-foreground">Error</dt>
                                  <dd className="text-destructive">{r.error}</dd>
                                </>
                              )}
                              <dt className="font-medium text-muted-foreground">Message</dt>
                              <dd className="font-mono">{r.gmail_message_id}</dd>
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </Card>
    </div>
  );
}
