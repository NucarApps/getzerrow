import { Fragment, useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listPubsubEvents,
  pingPubsubWebhook,
  listMyGmailAccounts,
  renewGmailWatch,
  retryJob,
  runJobsNow,
  getSyncLatencyStats,
} from "@/lib/gmail.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  RefreshCw, ChevronRight, ChevronDown, AlertTriangle,
  Activity, Copy, CheckCircle2, Info, Settings2, Gauge,
} from "lucide-react";
import { toast } from "sonner";
import { fmtLatency, latencyTone, LATENCY_TONE_CLASS, computeStaleness } from "./latency-format";

type Filter = "all" | "push" | "poll" | "errors" | "watch_renew";
type AlertKind = "danger" | "warn" | "success" | "info";

function relTime(iso: string | null | undefined): string {
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

const KIND_STYLE: Record<AlertKind, { border: string; bg: string; icon: string; title: string }> = {
  danger:  { border: "border-destructive/40",   bg: "bg-destructive/10",   icon: "text-destructive",                title: "text-destructive" },
  warn:    { border: "border-amber-500/40",     bg: "bg-amber-500/10",     icon: "text-amber-600",                  title: "text-amber-700 dark:text-amber-400" },
  success: { border: "border-emerald-500/40",   bg: "bg-emerald-500/10",   icon: "text-emerald-600",                title: "text-emerald-700 dark:text-emerald-400" },
  info:    { border: "border-blue-500/40",      bg: "bg-blue-500/10",      icon: "text-blue-600",                   title: "text-blue-700 dark:text-blue-400" },
};

function StatusAlert({
  kind, title, body, action, icon: IconComp,
}: {
  kind: AlertKind;
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
  icon?: typeof AlertTriangle;
}) {
  const s = KIND_STYLE[kind];
  const Icon = IconComp ?? (kind === "success" ? CheckCircle2 : kind === "info" ? Info : AlertTriangle);
  return (
    <div className={`flex flex-col gap-3 rounded-md border ${s.border} ${s.bg} p-3 md:flex-row md:items-start md:justify-between`}>
      <div className="flex min-w-0 gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${s.icon}`} />
        <div className="min-w-0 text-xs">
          <div className={`font-medium ${s.title}`}>{title}</div>
          {body && <div className="mt-1 text-muted-foreground">{body}</div>}
        </div>
      </div>
      {action && <div className="shrink-0 md:self-center">{action}</div>}
    </div>
  );
}

function CopyBtn({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard.writeText(value); toast.success("Copied"); }}
      className="inline-flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[10px] hover:bg-muted"
      title="Copy to clipboard"
    >
      <Copy className="h-3 w-3" /> copy
    </button>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: "danger" | "warn" }) {
  const tone =
    accent === "danger" ? "text-destructive" :
    accent === "warn" ? "text-amber-600" :
    "";
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

function KV({ k, v, mono, bad }: { k: string; v: React.ReactNode; mono?: boolean; bad?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className={`${mono ? "font-mono" : ""} ${bad ? "text-destructive" : ""} break-all`}>{v}</div>
    </div>
  );
}

// Operator-friendly indicator for "is the push stream flowing?".
// Decision is in computeStaleness (./latency-format.ts) so the SLO
// boundaries (1h amber, 6h red) are unit-testable.
function StalenessBadge({ lastPushAt, sampleCount }: { lastPushAt: string | null; sampleCount: number }) {
  const s = computeStaleness(lastPushAt, sampleCount);
  switch (s.kind) {
    case "none":
      return null;
    case "no_recent_push":
      return <Badge variant="outline" className="h-5 text-[10px] font-normal">no recent push</Badge>;
    case "live":
      return (
        <Badge variant="outline" className="h-5 border-emerald-500/40 bg-emerald-500/10 text-[10px] font-normal text-emerald-700 dark:text-emerald-400">
          live · last push {s.ageMinutes < 1 ? "<1m" : `${s.ageMinutes}m`} ago
        </Badge>
      );
    case "stale_amber":
      return (
        <Badge variant="outline" className="h-5 border-amber-500/40 bg-amber-500/10 text-[10px] font-normal text-amber-700 dark:text-amber-400">
          {Math.round(s.ageHours)}h stale
        </Badge>
      );
    case "stale_red":
      return (
        <Badge variant="destructive" className="h-5 text-[10px] font-normal">
          {s.ageHours >= 24 ? `${Math.round(s.ageHours / 24)}d stale` : `${Math.round(s.ageHours)}h stale`}
        </Badge>
      );
  }
}

function LatencyBucket({
  title, subtitle, bucket,
}: {
  title: string;
  subtitle: string;
  bucket: { count: number; p50: number | null; p95: number | null; p99: number | null } | undefined;
}) {
  const empty = !bucket || bucket.count === 0;
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-[11px] text-muted-foreground">{subtitle}</div>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground tabular-nums">
          {empty ? "no samples" : `n=${bucket!.count}`}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
        {(["p50", "p95", "p99"] as const).map((k) => {
          const v = bucket?.[k] ?? null;
          const tone = latencyTone(v);
          return (
            <div key={k}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
              <div className={`mt-1 text-lg font-semibold tabular-nums ${LATENCY_TONE_CLASS[tone]}`}>
                {fmtLatency(v)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Top-level health computation — derives a single "what should the user see
// first" alert from the stats + diagnostics blob so the banner area isn't a
// stack of 5 overlapping warnings.
type HealthState = {
  kind: AlertKind;
  title: React.ReactNode;
  body: React.ReactNode;
  action?: React.ReactNode;
};

function deriveHealth(args: {
  stats: any;
  diag: any;
  lastPush: any;
  lastRenew: any;
  watchActive: boolean;
  webhookUrl: string | undefined;
  pubsubTopic: string | undefined;
  renewBtn: React.ReactNode;
}): HealthState | null {
  const { stats, diag, lastPush, lastRenew, watchActive, webhookUrl, pubsubTopic, renewBtn } = args;

  const lastPushMs = lastPush ? new Date(lastPush.received_at).getTime() : 0;
  const lastRenewMs = lastRenew ? new Date(lastRenew.received_at).getTime() : 0;
  const lastPushAgeMin = lastPush ? Math.floor((Date.now() - lastPushMs) / 60000) : null;
  const lastPushStale = lastPush && lastPushAgeMin !== null && (lastPushAgeMin >= 10 || lastPushMs < lastRenewMs);

  // Severity order — first match wins.

  // RED: push received but didn't match an account.
  if (lastPush && !lastPushStale && lastPush.event_type === "push" && (lastPush.accounts_matched ?? 0) === 0) {
    return {
      kind: "danger",
      title: "Push arrived but didn't match a connected account",
      body: (
        <>
          Google delivered a Pub/Sub push, but the decoded <span className="font-mono">emailAddress</span>
          {lastPush.email_address ? <> (<span className="font-mono">{lastPush.email_address}</span>)</> : " was missing"}.
          The Gmail watch is probably attached to a different topic than the subscription forwarding here.
        </>
      ),
      action: renewBtn,
    };
  }

  // RED: watch armed but no real push since.
  if (lastRenew && Date.now() - lastRenewMs > 60_000 && lastPushMs < lastRenewMs) {
    return {
      kind: "danger",
      title: "Watch is armed, but no real Google push has arrived",
      body: (
        <>
          Watch re-armed {relTime(lastRenew.received_at)} against <span className="font-mono">{pubsubTopic ?? "(unset)"}</span>,
          but Google has not POSTed a real <span className="font-mono">push</span> envelope since. The GCP Pub/Sub
          push subscription is the likely broken piece — verify it POSTs to:
          {webhookUrl && (
            <div className="mt-1 font-mono break-all">{webhookUrl} <CopyBtn value={webhookUrl} /></div>
          )}
        </>
      ),
      action: renewBtn,
    };
  }

  // RED: 24h of zero push but watch active.
  if (stats && stats.push24 === 0 && stats.poll24 > 0 && watchActive) {
    return {
      kind: "danger",
      title: "Google is not pushing for your account",
      body: (
        <>
          Zero pushes in the last 24h, but polling is filling the gap ({stats.poll24} runs, {stats.synced24} synced).
          New mail arrives with a ~2 min delay. The GCP subscription is most likely paused or pointed at the wrong URL.
        </>
      ),
      action: renewBtn,
    };
  }

  // AMBER: poll has stalled.
  const lastPollMs = stats?.lastPollAt ? new Date(stats.lastPollAt).getTime() : 0;
  const pollSilentMin = stats?.lastPollAt ? Math.floor((Date.now() - lastPollMs) / 60000) : null;
  const pollStalled = (pollSilentMin === null || pollSilentMin >= 10) && stats?.push24 > 0;
  if (pollStalled) {
    return {
      kind: "warn",
      title: `Fallback poll hasn't run in ${pollSilentMin === null ? "24h+" : `${pollSilentMin}m`}`,
      body: <>The 2-minute poll is your safety net for missed Gmail pushes. Push is working now, but if it drops there's nothing catching it. The scheduled job that calls <span className="font-mono">/api/public/gmail-poll</span> may be paused.</>,
    };
  }

  // AMBER: total silence.
  if (stats && stats.push24 === 0 && stats.poll24 === 0) {
    return {
      kind: "warn",
      title: "No sync activity in the last 24h",
      body: <>Neither push nor poll has fired. The cron job that calls <span className="font-mono">/api/public/gmail-poll</span> may be paused.</>,
    };
  }

  // GREEN: push healthy.
  const pushSilentMin = stats?.lastPushAt
    ? Math.floor((Date.now() - new Date(stats.lastPushAt).getTime()) / 60000)
    : null;
  const pushHealthy =
    stats && stats.push24 > 0 && (stats.push24 - (stats.pushUnmatched24 ?? 0)) > 0 &&
    pushSilentMin !== null && pushSilentMin < 10;
  if (pushHealthy) {
    return {
      kind: "success",
      title: "Push is healthy",
      body: <>{stats.push24} pushes in the last 24h, last one {relTime(stats.lastPushAt)}. New mail is arriving in real time.</>,
    };
  }

  // INFO: poll keeping it alive.
  if (stats && !pushHealthy && stats.poll24 > 0) {
    return {
      kind: "info",
      title: "Fallback poll is keeping mail flowing",
      body: <>{stats.poll24} poll runs in the last 24h, {stats.synced24} messages synced. Real-time push is degraded so mail shows up with a small delay.</>,
    };
  }

  return null;
}

export function PubsubActivity() {
  const fetchEvents = useServerFn(listPubsubEvents);
  const pingFn = useServerFn(pingPubsubWebhook);
  const accountsFn = useServerFn(listMyGmailAccounts);
  const renewFn = useServerFn(renewGmailWatch);
  const retryFn = useServerFn(retryJob);
  const runJobsFn = useServerFn(runJobsNow);
  const latencyFn = useServerFn(getSyncLatencyStats);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pinging, setPinging] = useState<null | "empty" | "realistic">(null);
  const [pingResult, setPingResult] = useState<null | { ok: boolean; status: number; elapsed_ms: number; topic_set: boolean; mode?: string; account_email?: string | null; error?: string; url: string }>(null);
  const [renewing, setRenewing] = useState(false);
  const [showLastPush, setShowLastPush] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

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
    refetchInterval: 10_000,
  });

  const accountsQ = useQuery({
    queryKey: ["my-gmail-accounts-pubsub"],
    queryFn: () => accountsFn(),
  });

  // Latency telemetry runs on a slower cadence than the event log — it
  // queries the SQL percentile aggregator, which is the expensive bit, and
  // the numbers don't move fast enough to need 10s refreshes.
  const latencyQ = useQuery({
    queryKey: ["sync-latency-24h"],
    queryFn: () => latencyFn({ data: { lookback_hours: 24 } }),
    refetchInterval: 60_000,
  });

  const events = q.data?.events ?? [];
  const stats = q.data?.stats;
  const diag = q.data?.diagnostics as
    | (NonNullable<typeof q.data>["diagnostics"] & { lastWebhookTest?: { received_at: string } | null; pendingJobs?: number; oldestPendingAt?: string | null; stuckJobs?: any[] })
    | undefined;
  const lastPush = diag?.lastPush ?? null;
  const lastRenew = diag?.lastWatchRenew ?? null;
  const lastWebhookTest = diag?.lastWebhookTest ?? null;
  const watchActive = (accountsQ.data?.accounts ?? []).some(
    (a) => a.watch_expiration && new Date(a.watch_expiration).getTime() > Date.now(),
  );

  async function rearm(accountId: string) {
    setRenewing(true);
    try {
      await renewFn({ data: { account_id: accountId } });
      toast.success("Watch re-armed");
      q.refetch();
      accountsQ.refetch();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRenewing(false);
    }
  }

  const renewBtn = (
    <Button
      size="sm"
      variant="destructive"
      disabled={renewing || (accountsQ.data?.accounts ?? []).length === 0}
      onClick={() => {
        const acc = (accountsQ.data?.accounts ?? [])[0];
        if (acc) void rearm(acc.id);
      }}
    >
      <RefreshCw className={`mr-2 h-4 w-4 ${renewing ? "animate-spin" : ""}`} />
      Re-arm push watch
    </Button>
  );

  const health = useMemo(
    () => deriveHealth({
      stats, diag, lastPush, lastRenew, watchActive,
      webhookUrl: diag?.webhookUrl ?? undefined, pubsubTopic: diag?.pubsubTopic ?? undefined,
      renewBtn,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stats, diag, lastPush, lastRenew, watchActive, renewing],
  );

  // Secondary alerts that aren't the top-level health state but still need
  // surfacing. Stuck jobs + processing backlog are about the worker queue
  // not the push pipeline, so they coexist with `health` rather than replace it.
  const stuckJobs = diag?.stuckJobs ?? [];
  const pendingJobs = diag?.pendingJobs ?? 0;
  const oldestPendingAt = diag?.oldestPendingAt ?? null;
  const oldestPendingAgeMin = oldestPendingAt
    ? Math.floor((Date.now() - new Date(oldestPendingAt).getTime()) / 60000)
    : 0;
  const processingBacklog = pendingJobs >= 5 || oldestPendingAgeMin >= 2;

  return (
    <Card className="overflow-hidden p-0">
      {/* Header */}
      <div className="flex flex-col gap-3 border-b bg-muted/20 p-4 md:flex-row md:items-start md:justify-between md:p-6">
        <div>
          <h2 className="font-display text-2xl">Gmail sync activity</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live feed of every push from Gmail and every fallback poll run.
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

      <div className="space-y-6 p-4 md:p-6">
        {/* STATUS: top-level health + secondary worker-queue alerts */}
        <section className="space-y-3">
          {health && <StatusAlert {...health} />}

          {stuckJobs.length > 0 && (
            <StatusAlert
              kind="warn"
              title={`${stuckJobs.length} message ${stuckJobs.length === 1 ? "job is" : "jobs are"} stuck`}
              body="A worker died mid-processing (usually Cloudflare wall-time timeout). They will auto-reclaim on the next tick — force a retry below."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      const r = await runJobsFn({ data: { limit: 50 } });
                      toast.success(`Drained ${r.ok} jobs (${r.failed} failed, ${r.dlq} DLQ)`);
                      q.refetch();
                    } catch (e) { toast.error((e as Error).message); }
                  }}
                >
                  Run worker now
                </Button>
              }
            />
          )}

          {/* Inline stuck-jobs detail list (when expanded section already has the banner) */}
          {stuckJobs.length > 0 && (
            <div className="space-y-1.5 rounded-md border p-3">
              <div className="text-xs font-medium text-muted-foreground">Stuck jobs</div>
              {stuckJobs.map((j: { id: string; subject?: string | null; from_addr?: string | null; gmail_message_id: string; attempt?: number; locked_at?: string }) => (
                <div key={j.id} className="flex items-center justify-between gap-2 rounded border bg-card p-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{j.subject ?? "(no subject yet)"} <span className="font-normal text-muted-foreground">— {j.from_addr ?? "unknown sender"}</span></div>
                    <div className="font-mono text-[10px] text-muted-foreground">msg {j.gmail_message_id} · attempt {j.attempt ?? 0} · locked {relTime(j.locked_at)}</div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={retryingJob === j.id}
                    onClick={async () => {
                      setRetryingJob(j.id);
                      try {
                        await retryFn({ data: { id: j.id } });
                        await runJobsFn({ data: { limit: 5 } });
                        toast.success("Retried");
                        q.refetch();
                      } catch (e) { toast.error((e as Error).message); }
                      finally { setRetryingJob(null); }
                    }}
                  >
                    <RefreshCw className={`mr-1 h-3 w-3 ${retryingJob === j.id ? "animate-spin" : ""}`} />
                    Force retry
                  </Button>
                </div>
              ))}
            </div>
          )}

          {processingBacklog && (
            <StatusAlert
              kind="warn"
              title={`Processing delay — ${pendingJobs} message${pendingJobs === 1 ? "" : "s"} waiting${oldestPendingAgeMin > 0 ? ` (oldest ${oldestPendingAgeMin}m)` : ""}`}
              body="Gmail is delivering, but the background worker hasn't drained the queue yet. The per-minute cron may have missed a tick."
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      const r = await runJobsFn({ data: { limit: 100 } });
                      toast.success(`Drained ${r.ok} (${r.failed} failed, ${r.dlq} DLQ)`);
                      q.refetch();
                    } catch (e) { toast.error((e as Error).message); }
                  }}
                >
                  Drain queue now
                </Button>
              }
            />
          )}

          {stats && stats.gmailErrors24 > 0 && (
            <StatusAlert
              kind="info"
              title={`Gmail API returned ${stats.gmailErrors24} transient error${stats.gmailErrors24 === 1 ? "" : "s"} in the last 24h`}
              body="429 (rate limit) or 5xx from Google. The worker auto-retries with jittered backoff; the first 2 retryable failures are free."
            />
          )}
        </section>

        {/* STATS */}
        {stats && (
          <section>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatCard label="Push (24h)" value={stats.push24} />
              <StatCard label="Poll (24h)" value={stats.poll24} />
              <StatCard label="Watch renew" value={stats.renew24} />
              <StatCard label="Accounts matched" value={stats.accounts24} />
              <StatCard label="Emails synced" value={stats.synced24} />
              <StatCard label="Errors" value={stats.errors24} accent={stats.errors24 > 0 ? "danger" : undefined} />
            </div>
            <div className="mt-3 text-xs text-muted-foreground">
              Last event {stats.lastReceivedAt ? `${relTime(stats.lastReceivedAt)} (${new Date(stats.lastReceivedAt).toLocaleString()})` : "never"}
              {stats.lastPushAt && <> · Last push {relTime(stats.lastPushAt)}</>}
              {stats.lastPollAt && <> · Last poll {relTime(stats.lastPollAt)}</>}
            </div>
          </section>
        )}

        {/* LATENCY — push→ack and push→visible percentiles over 24h */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium">Push latency (last 24h)</h3>
              <StalenessBadge lastPushAt={stats?.lastPushAt ?? null} sampleCount={latencyQ.data?.push_to_ack?.count ?? 0} />
            </div>
            <span className="text-[11px] text-muted-foreground">
              {latencyQ.isFetching ? "refreshing…" : "auto-refreshes every minute"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <LatencyBucket
              title="Push → ack"
              subtitle="time from Pub/Sub publish to our webhook 200"
              bucket={latencyQ.data?.push_to_ack}
            />
            <LatencyBucket
              title="Push → visible"
              subtitle="time from Pub/Sub publish to the email row appearing"
              bucket={latencyQ.data?.push_to_visible}
            />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Targets: p50 &lt; 1s (green), p50 &lt; 3s (amber). Anything beyond suggests the worker queue is backed up or Gmail API is slow.
            {latencyQ.data?.push_to_ack?.count === 0 && latencyQ.data?.push_to_visible?.count === 0 && (
              <> Latency telemetry populates on every real Pub/Sub push — &quot;no samples&quot; means push hasn&apos;t fired in the lookback window.</>
            )}
            {("error" in (latencyQ.data ?? {})) && (
              <span className="text-destructive"> · RPC error: {(latencyQ.data as { error?: string }).error}</span>
            )}
          </p>
        </section>

        {/* LAST PUSH DETAIL */}
        {lastPush && (
          <Collapsible open={showLastPush} onOpenChange={setShowLastPush}>
            <section className="rounded-md border bg-muted/20">
              <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-left text-sm font-medium hover:bg-muted/40">
                <span className="flex flex-wrap items-center gap-2">
                  {showLastPush ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  Last push from Google ({lastPush.event_type})
                  <span className="text-xs font-normal text-muted-foreground">— {relTime(lastPush.received_at)}</span>
                  <LastPushStaleBadge lastPush={lastPush} lastRenew={lastRenew} />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="space-y-2 border-t p-3 text-xs">
                  <div className="grid gap-2 md:grid-cols-2">
                    <KV k="emailAddress (decoded)" v={lastPush.email_address ?? "(missing)"} bad={!lastPush.email_address} />
                    <KV k="historyId (decoded)" v={lastPush.history_id ?? "(missing)"} bad={!lastPush.history_id} />
                    <KV k="accounts_matched" v={String(lastPush.accounts_matched ?? 0)} bad={(lastPush.accounts_matched ?? 0) === 0} />
                    <KV k="Pub/Sub messageId" v={lastPush.message_id ?? "—"} />
                    <KV k="Pub/Sub publishTime" v={lastPush.publish_time ?? "—"} />
                    <KV k="Pub/Sub subscription" v={lastPush.subscription ?? "—"} mono />
                  </div>
                  {lastPush.details && (
                    <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                      {lastPush.details}
                    </div>
                  )}
                  {lastPush.payload != null && (
                    <details>
                      <summary className="cursor-pointer text-muted-foreground">Raw decoded payload</summary>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded border bg-card p-2 text-[11px]">
{JSON.stringify(lastPush.payload, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>
        )}

        {/* EVENT LOG */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Event log</h3>
            <div className="flex flex-wrap gap-1.5">
              {(["all", "push", "poll", "errors", "watch_renew"] as Filter[]).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant={filter === f ? "default" : "outline"}
                  className="h-7 px-2 text-xs"
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : f === "push" ? "Push" : f === "poll" ? "Poll" : f === "errors" ? "Errors" : "Renewals"}
                </Button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto rounded-md border">
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
                  <th className="p-2">Error / details</th>
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
                          <Badge
                            variant={
                              e.error ? "destructive" :
                              e.event_type === "push" ? "default" :
                              e.event_type === "poll" ? "secondary" :
                              "outline"
                            }
                            className="text-[10px]"
                          >
                            {e.event_type}
                          </Badge>
                        </td>
                        <td className="p-2 max-w-[200px] truncate">{e.email_address ?? "—"}</td>
                        <td className="p-2 font-mono">{e.history_id ?? "—"}</td>
                        <td className="p-2 text-right tabular-nums">{e.accounts_matched ?? "—"}</td>
                        <td className="p-2 text-right tabular-nums">{e.synced_count ?? "—"}</td>
                        <td className="p-2 max-w-[240px] truncate text-destructive">{e.error ?? e.details ?? ""}</td>
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
        </section>

        {/* DIAGNOSTICS — collapsed by default; only opened when troubleshooting */}
        <Collapsible open={showDiagnostics} onOpenChange={setShowDiagnostics}>
          <section className="rounded-md border bg-muted/20">
            <CollapsibleTrigger className="flex w-full items-center justify-between p-3 text-left text-sm font-medium hover:bg-muted/40">
              <span className="flex items-center gap-2">
                <Settings2 className="h-4 w-4" />
                Push subscription diagnostics
              </span>
              {showDiagnostics ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="space-y-4 border-t p-3 text-xs">
                {lastRenew && (
                  <StatusAlert
                    kind="info"
                    icon={Activity}
                    title={
                      <>
                        Watch re-armed {relTime(lastRenew.received_at)}
                        {(() => {
                          const lastPushMs = lastPush ? new Date(lastPush.received_at).getTime() : 0;
                          const lastRenewMs = lastRenew ? new Date(lastRenew.received_at).getTime() : 0;
                          const verified =
                            lastPushMs > lastRenewMs &&
                            lastPush?.event_type === "push" &&
                            (lastPush.accounts_matched ?? 0) > 0;
                          return verified ? <span className="ml-2 text-emerald-700 dark:text-emerald-400">· verified by a fresh matched push ✓</span> : null;
                        })()}
                      </>
                    }
                    body={
                      <>
                        {lastRenew.details && <div className="break-all">{lastRenew.details}</div>}
                        <div className="mt-1"><strong>How to verify:</strong> send yourself an email from another account and watch this panel for ~30s. A new <span className="font-mono">push</span> row with <span className="font-mono">accounts_matched ≥ 1</span> means real-time push is working.</div>
                      </>
                    }
                  />
                )}

                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Connected accounts</div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {(accountsQ.data?.accounts ?? []).map((a) => (
                      <div key={a.id} className="rounded border bg-card p-2">
                        <div className="truncate font-medium">{a.email_address}</div>
                        <dl className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
                          <div>History ID: <span className="font-mono">{a.history_id ?? "—"}</span></div>
                          <div>Watch expires: {a.watch_expiration ? new Date(a.watch_expiration).toLocaleString() : "—"}</div>
                          <div>Last poll: {a.last_poll_at ? relTime(a.last_poll_at) : "—"}</div>
                        </dl>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">Webhook reachability test</div>
                  <div className="flex flex-wrap items-center gap-3">
                    {(["empty", "realistic"] as const).map((mode) => (
                      <Button
                        key={mode}
                        size="sm"
                        variant="outline"
                        disabled={pinging !== null}
                        onClick={async () => {
                          setPinging(mode);
                          setPingResult(null);
                          try {
                            const r = await pingFn({ data: { realistic: mode === "realistic" } });
                            setPingResult(r);
                            if (r.ok) toast.success(`Webhook reachable (${r.status} in ${r.elapsed_ms}ms)`);
                            else toast.error(`Webhook returned ${r.status}`);
                            q.refetch();
                          } catch (e) {
                            toast.error((e as Error).message);
                          } finally {
                            setPinging(null);
                          }
                        }}
                      >
                        <RefreshCw className={`mr-2 h-4 w-4 ${pinging === mode ? "animate-spin" : ""}`} />
                        {mode === "empty" ? "Test reachable" : "Test with account payload"}
                      </Button>
                    ))}
                    {pingResult && (
                      <div className="text-xs text-muted-foreground">
                        <span className={pingResult.ok ? "text-foreground" : "text-destructive"}>
                          {pingResult.ok ? "✓" : "✗"} {pingResult.status} · {pingResult.elapsed_ms}ms
                        </span>
                        {pingResult.mode && <> · mode: <span className="font-mono">{pingResult.mode}</span></>}
                        {pingResult.account_email && <> · {pingResult.account_email}</>}
                        {" · "}
                        topic: {pingResult.topic_set ? "set" : <span className="text-destructive">not set</span>}
                        {pingResult.error && <span className="text-destructive"> · {pingResult.error}</span>}
                      </div>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Logged as <span className="font-mono">webhook_test</span> — proves our endpoint works but does NOT prove the GCP push subscription is delivering. Only a real <span className="font-mono">push</span> row from Google does that.
                    {lastWebhookTest && <> · Last test {relTime(lastWebhookTest.received_at)}</>}
                  </p>
                </div>

                <div className="rounded border bg-card p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">GCP Pub/Sub setup checklist</div>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
                    <li>
                      Topic must equal{" "}
                      <span className="font-mono">{diag?.pubsubTopic ?? "(GMAIL_PUBSUB_TOPIC not set)"}</span>
                      {diag?.pubsubTopic && <> <CopyBtn value={diag.pubsubTopic} /></>}
                    </li>
                    <li>
                      A <strong>push</strong> subscription on that topic must POST to{" "}
                      <span className="font-mono">{diag?.webhookUrl}</span>
                      {diag?.webhookUrl && <> <CopyBtn value={diag.webhookUrl} /></>}
                    </li>
                    <li>
                      <span className="font-mono">gmail-api-push@system.gserviceaccount.com</span> needs <span className="font-mono">roles/pubsub.publisher</span> on the topic.
                    </li>
                    <li>Subscription must not be paused; ack deadline ≥ 10s.</li>
                    <li>The Gmail watch must be re-armed against the same topic (use the button above).</li>
                  </ol>
                </div>
              </div>
            </CollapsibleContent>
          </section>
        </Collapsible>
      </div>
    </Card>
  );
}

function LastPushStaleBadge({ lastPush, lastRenew }: { lastPush: { received_at: string }; lastRenew: { received_at: string } | null }) {
  const lastPushMs = new Date(lastPush.received_at).getTime();
  const lastRenewMs = lastRenew ? new Date(lastRenew.received_at).getTime() : 0;
  const ageMin = Math.floor((Date.now() - lastPushMs) / 60000);
  const stale = ageMin >= 10 || lastPushMs < lastRenewMs;
  if (!stale) return null;
  return (
    <Badge variant="outline" className="text-[10px]">
      stale{lastRenew && lastPushMs < lastRenewMs ? " · before last re-arm" : ""}
    </Badge>
  );
}
