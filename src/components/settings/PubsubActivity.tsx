import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPubsubEvents, pingPubsubWebhook, listMyGmailAccounts, renewGmailWatch } from "@/lib/gmail.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, ChevronRight, ChevronDown, AlertTriangle, Activity } from "lucide-react";
import { toast } from "sonner";

type Filter = "all" | "push" | "errors" | "watch_renew";

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function PubsubActivity() {
  const fetchEvents = useServerFn(listPubsubEvents);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["pubsub-events", filter],
    queryFn: () =>
      fetchEvents({
        data: {
          event_type: filter === "push" ? "push" : filter === "watch_renew" ? "watch_renew" : undefined,
          only_errors: filter === "errors" ? true : undefined,
          limit: 100,
        },
      }),
    refetchInterval: 10000,
  });

  const events = q.data?.events ?? [];
  const stats = q.data?.stats;

  return (
    <Card className="p-4 md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="font-display text-2xl">Gmail Pub/Sub activity</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Raw push notifications from Gmail. Use this to verify whether new emails are arriving via push or only via the 2-minute fallback poll.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="self-start md:self-auto"
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {stats && (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Push (24h)" value={stats.push24} />
          <Stat label="Watch renew (24h)" value={stats.renew24} />
          <Stat label="Accounts matched" value={stats.accounts24} />
          <Stat label="Emails synced" value={stats.synced24} />
          <Stat label="Errors" value={stats.errors24} accent={stats.errors24 > 0 ? "danger" : undefined} />
        </div>
      )}

      <div className="mt-3 text-xs text-muted-foreground">
        Last event: {stats?.lastReceivedAt ? `${relTime(stats.lastReceivedAt)} (${new Date(stats.lastReceivedAt).toLocaleString()})` : "never"}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {(["all", "push", "errors", "watch_renew"] as Filter[]).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "push" ? "Push only" : f === "errors" ? "Errors only" : "Watch renewals"}
          </Button>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="w-6 p-2"></th>
              <th className="p-2">When</th>
              <th className="p-2">Type</th>
              <th className="p-2">Email</th>
              <th className="p-2">History ID</th>
              <th className="p-2 text-right">Matched</th>
              <th className="p-2 text-right">Synced</th>
              <th className="p-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!q.isLoading && events.length === 0 && (
              <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">No events yet.</td></tr>
            )}
            {events.map((e) => {
              const isOpen = expanded === e.id;
              return (
                <Fragment key={e.id}>
                  <tr
                    className="cursor-pointer border-t hover:bg-muted/30"
                    onClick={() => setExpanded(isOpen ? null : e.id)}
                  >
                    <td className="p-2">{isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</td>
                    <td className="p-2 whitespace-nowrap" title={new Date(e.received_at).toLocaleString()}>
                      {relTime(e.received_at)}
                    </td>
                    <td className="p-2">
                      <Badge variant={e.event_type === "push" ? "default" : "secondary"} className="text-[10px]">
                        {e.event_type}
                      </Badge>
                    </td>
                    <td className="p-2 max-w-[200px] truncate">{e.email_address ?? "—"}</td>
                    <td className="p-2 font-mono">{e.history_id ?? "—"}</td>
                    <td className="p-2 text-right">{e.accounts_matched ?? "—"}</td>
                    <td className="p-2 text-right">{e.synced_count ?? "—"}</td>
                    <td className="p-2 max-w-[200px] truncate text-destructive">{e.error ?? ""}</td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t bg-muted/20">
                      <td></td>
                      <td colSpan={7} className="p-2">
                        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-[11px]">
{JSON.stringify(e, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "danger" }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${accent === "danger" ? "text-destructive" : ""}`}>{value}</div>
    </div>
  );
}
