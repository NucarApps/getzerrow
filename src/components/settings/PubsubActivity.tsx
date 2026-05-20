import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPubsubEvents, pingPubsubWebhook, listMyGmailAccounts, renewGmailWatch } from "@/lib/gmail.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, ChevronRight, ChevronDown, AlertTriangle, Activity } from "lucide-react";
import { toast } from "sonner";

type Filter = "all" | "push" | "poll" | "errors" | "watch_renew";

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
  const pingFn = useServerFn(pingPubsubWebhook);
  const accountsFn = useServerFn(listMyGmailAccounts);
  const renewFn = useServerFn(renewGmailWatch);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<null | { ok: boolean; status: number; elapsed_ms: number; topic_set: boolean; error?: string; url: string }>(null);
  const [renewing, setRenewing] = useState(false);

  const q = useQuery({
    queryKey: ["pubsub-events", filter],
    queryFn: () =>
      fetchEvents({
        data: {
          event_type:
            filter === "push" ? "push" :
            filter === "poll" ? "poll" :
            filter === "watch_renew" ? "watch_renew" :
            undefined,
          only_errors: filter === "errors" ? true : undefined,
          limit: 100,
        },
      }),
    refetchInterval: 10000,
  });

  const accountsQ = useQuery({
    queryKey: ["my-gmail-accounts-pubsub"],
    queryFn: () => accountsFn(),
  });

  const events = q.data?.events ?? [];
  const stats = q.data?.stats;

  return (
    <Card className="p-4 md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="font-display text-2xl">Gmail sync activity</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live feed of every push notification from Gmail and every fallback poll run. Use this to see whether new mail is arriving via push, via the 2-minute poll, or not at all.
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

      {stats && stats.push24 === 0 && stats.poll24 > 0 && (accountsQ.data?.accounts ?? []).some((a) => a.watch_expiration && new Date(a.watch_expiration).getTime() > Date.now()) && (
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 md:flex-row md:items-start md:justify-between">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-xs">
              <div className="font-medium text-destructive">Gmail push notifications are not arriving.</div>
              <div className="mt-1 text-muted-foreground">
                Zero push events in the last 24h, but the fallback poll is running ({stats.poll24} runs) so mail is still flowing. The Gmail watch is still active — re-arm it to refresh Google's push subscription. If that doesn't help, the GCP Pub/Sub subscription is missing or pointed at the wrong URL.
              </div>
            </div>
          </div>
          <Button
            size="sm"
            variant="destructive"
            disabled={renewing}
            onClick={async () => {
              const acc = (accountsQ.data?.accounts ?? [])[0];
              if (!acc) return;
              setRenewing(true);
              try {
                await renewFn({ data: { account_id: acc.id } });
                toast.success("Watch re-armed");
                q.refetch();
                accountsQ.refetch();
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setRenewing(false);
              }
            }}
            className="shrink-0"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${renewing ? "animate-spin" : ""}`} />
            Re-arm push watch
          </Button>
        </div>
      )}

      {stats && stats.push24 === 0 && stats.poll24 === 0 && (
        <div className="mt-4 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-xs">
            <div className="font-medium text-amber-700 dark:text-amber-400">No sync activity in the last 24h.</div>
            <div className="mt-1 text-muted-foreground">
              Neither push nor poll has fired. The cron job that calls <span className="font-mono">/api/public/gmail-poll</span> may be paused, or the worker route is failing. Check the cron schedule and recent deployment logs.
            </div>
          </div>
        </div>
      )}

      {stats && stats.poll24 > 0 && (
        <div className="mt-4 flex gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <div className="text-xs">
            <div className="font-medium text-emerald-700 dark:text-emerald-400">Fallback poll is healthy.</div>
            <div className="mt-1 text-muted-foreground">
              {stats.poll24} poll runs in the last 24h, {stats.synced24} messages synced. Last poll {stats.lastPollAt ? relTime(stats.lastPollAt) : "—"}.
            </div>
          </div>
        </div>
      )}

      {stats && (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-6">
          <Stat label="Push (24h)" value={stats.push24} />
          <Stat label="Poll (24h)" value={stats.poll24} />
          <Stat label="Watch renew (24h)" value={stats.renew24} />
          <Stat label="Accounts matched" value={stats.accounts24} />
          <Stat label="Emails synced" value={stats.synced24} />
          <Stat label="Errors" value={stats.errors24} accent={stats.errors24 > 0 ? "danger" : undefined} />
        </div>
      )}

      <div className="mt-3 text-xs text-muted-foreground">
        Last event: {stats?.lastReceivedAt ? `${relTime(stats.lastReceivedAt)} (${new Date(stats.lastReceivedAt).toLocaleString()})` : "never"}
        {stats?.lastPushAt && <> · Last push: {relTime(stats.lastPushAt)}</>}
        {stats?.lastPollAt && <> · Last poll: {relTime(stats.lastPollAt)}</>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {(["all", "push", "poll", "errors", "watch_renew"] as Filter[]).map((f) => (
          <Button
            key={f}
            size="sm"
            variant={filter === f ? "default" : "outline"}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? "All" : f === "push" ? "Push only" : f === "poll" ? "Poll only" : f === "errors" ? "Errors only" : "Watch renewals"}
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

      <div className="mt-6 rounded-md border bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Activity className="h-4 w-4" />
          Push subscription diagnostics
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
          {(accountsQ.data?.accounts ?? []).map((a) => (
            <div key={a.id} className="rounded border bg-card p-2">
              <div className="font-medium">{a.email_address}</div>
              <div className="text-muted-foreground">
                History ID: <span className="font-mono">{a.history_id ?? "—"}</span>
              </div>
              <div className="text-muted-foreground">
                Watch expires: {a.watch_expiration ? new Date(a.watch_expiration).toLocaleString() : "—"}
              </div>
              <div className="text-muted-foreground">
                Last poll: {a.last_poll_at ? relTime(a.last_poll_at) : "—"}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={pinging}
            onClick={async () => {
              setPinging(true);
              setPingResult(null);
              try {
                const r = await pingFn();
                setPingResult(r);
                if (r.ok) toast.success(`Webhook reachable (${r.status} in ${r.elapsed_ms}ms)`);
                else toast.error(`Webhook returned ${r.status}`);
                q.refetch();
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setPinging(false);
              }
            }}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${pinging ? "animate-spin" : ""}`} />
            Send test request to webhook
          </Button>
          {pingResult && (
            <div className="text-xs text-muted-foreground">
              <span className={pingResult.ok ? "text-foreground" : "text-destructive"}>
                {pingResult.ok ? "✓" : "✗"} {pingResult.status} · {pingResult.elapsed_ms}ms
              </span>
              {" · "}
              GMAIL_PUBSUB_TOPIC: {pingResult.topic_set ? "set" : <span className="text-destructive">not set</span>}
              {pingResult.error && <span className="text-destructive"> · {pingResult.error}</span>}
            </div>
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          A successful test means our endpoint accepts pushes — so if real pushes are still missing, the Google Cloud Pub/Sub subscription is either missing, paused, or pointed at the wrong URL.
        </p>
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
