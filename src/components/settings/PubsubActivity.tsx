import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPubsubEvents, pingPubsubWebhook, listMyGmailAccounts, renewGmailWatch, retryJob, runJobsNow } from "@/lib/gmail.functions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, ChevronRight, ChevronDown, AlertTriangle, Activity, Copy, CheckCircle2 } from "lucide-react";
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

function CopyBtn({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => { navigator.clipboard.writeText(value); toast.success("Copied"); }}
      className="inline-flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[10px] hover:bg-muted"
    >
      <Copy className="h-3 w-3" /> copy
    </button>
  );
}

export function PubsubActivity() {
  const fetchEvents = useServerFn(listPubsubEvents);
  const pingFn = useServerFn(pingPubsubWebhook);
  const accountsFn = useServerFn(listMyGmailAccounts);
  const renewFn = useServerFn(renewGmailWatch);
  const retryFn = useServerFn(retryJob);
  const runJobsFn = useServerFn(runJobsNow);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pinging, setPinging] = useState<null | "empty" | "realistic">(null);
  const [pingResult, setPingResult] = useState<null | { ok: boolean; status: number; elapsed_ms: number; topic_set: boolean; mode?: string; account_email?: string | null; error?: string; url: string }>(null);
  const [renewing, setRenewing] = useState(false);
  const [showLastPush, setShowLastPush] = useState(false);

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
  const diag = q.data?.diagnostics;
  const lastPush = diag?.lastPush ?? null;
  const lastRenew = diag?.lastWatchRenew ?? null;
  const lastWebhookTest = (diag as any)?.lastWebhookTest ?? null;
  const watchActive = (accountsQ.data?.accounts ?? []).some(
    (a) => a.watch_expiration && new Date(a.watch_expiration).getTime() > Date.now()
  );
  const pushSilentMin = stats?.lastPushAt
    ? Math.floor((Date.now() - new Date(stats.lastPushAt).getTime()) / 60000)
    : null;
  const pushHealthy =
    stats && stats.push24 > 0 && (stats.push24 - (stats.pushUnmatched24 ?? 0)) > 0 &&
    pushSilentMin !== null && pushSilentMin < 10;

  // Is lastPush stale (older than 10 min, or older than the most recent re-arm)?
  const lastPushMs = lastPush ? new Date(lastPush.received_at).getTime() : 0;
  const lastRenewMs = lastRenew ? new Date(lastRenew.received_at).getTime() : 0;
  const lastPushAgeMin = lastPush ? Math.floor((Date.now() - lastPushMs) / 60000) : null;
  const lastPushStale = lastPush ? (lastPushAgeMin! >= 10 || lastPushMs < lastRenewMs) : false;
  // Only the FRESH version of the "didn't match" condition should trigger the red banner.
  const showUnmatchedBanner =
    !!lastPush &&
    !lastPushStale &&
    lastPush.event_type === "push" &&
    (lastPush.accounts_matched ?? 0) === 0;

  // After a re-arm, if no real Google push has arrived, the GCP subscription
  // is the broken piece. Show this as soon as the re-arm is >60s old.
  const noPushSinceRearm =
    !!lastRenew &&
    Date.now() - lastRenewMs > 60_000 &&
    lastPushMs < lastRenewMs;


  const renewBtn = (
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
  );

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

      {/* RED: push received but payload didn't match account */}
      {showUnmatchedBanner && (
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 md:flex-row md:items-start md:justify-between">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-xs">
              <div className="font-medium text-destructive">Push arrived but didn't match a connected account.</div>
              <div className="mt-1 text-muted-foreground">
                Google delivered a Pub/Sub push, but the decoded <span className="font-mono">emailAddress</span> {lastPush.email_address ? <>(<span className="font-mono">{lastPush.email_address}</span>)</> : "was missing"} doesn't match any account in this app. The Gmail watch is almost certainly attached to a different Google project or a different topic than the subscription forwarding to us. Re-arming forces a new watch against <span className="font-mono">{diag?.pubsubTopic ?? "GMAIL_PUBSUB_TOPIC (unset)"}</span>.
              </div>
            </div>
          </div>
          {renewBtn}
        </div>
      )}

      {/* AMBER: stuck jobs (worker timed out mid-processing) */}
      {diag?.stuckJobs && diag.stuckJobs.length > 0 && (
        <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="flex-1 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-amber-700 dark:text-amber-400">
                  {diag.stuckJobs.length} message {diag.stuckJobs.length === 1 ? "job is" : "jobs are"} stuck.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      const r = await runJobsFn({ data: { limit: 50 } });
                      toast.success(`Drained ${r.ok} jobs (${r.failed} failed, ${r.dlq} DLQ)`);
                      q.refetch();
                    } catch (e: any) { toast.error(e.message); }
                  }}
                >
                  Run worker now
                </Button>
              </div>
              <div className="mt-1 text-muted-foreground">
                These jobs were claimed by a worker that died mid-processing (usually a Cloudflare Worker wall-time timeout while calling Gmail GetMessage or the AI classifier). They will auto-reclaim on the next poll, but you can force a retry below.
              </div>
              <div className="mt-3 space-y-1.5">
                {diag.stuckJobs.map((j: any) => (
                  <div key={j.id} className="flex items-center justify-between gap-2 rounded border bg-card p-2">
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
                        } catch (e: any) { toast.error(e.message); }
                        finally { setRetryingJob(null); }
                      }}
                    >
                      <RefreshCw className={`mr-1 h-3 w-3 ${retryingJob === j.id ? "animate-spin" : ""}`} />
                      Force retry
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* RED: push completely silent but poll is working */}
      {stats && stats.push24 === 0 && stats.poll24 > 0 && watchActive && (
        <div className="mt-4 flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 md:flex-row md:items-start md:justify-between">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-xs">
              <div className="font-medium text-destructive">Google is not pushing for your account.</div>
              <div className="mt-1 text-muted-foreground">
                Zero pushes in the last 24h, but fallback polling is running ({stats.poll24} runs, {stats.synced24} synced). That means new mail is arriving with a ~2 min delay instead of in real time. The watch is still alive, so the GCP Pub/Sub subscription is most likely paused, missing, or pointed at the wrong URL.
                <div className="mt-2">
                  Subscription must POST to:{" "}
                  <span className="font-mono">{diag?.webhookUrl}</span>{" "}
                  {diag?.webhookUrl && <CopyBtn value={diag.webhookUrl} />}
                </div>
              </div>
            </div>
          </div>
          {renewBtn}
        </div>
      )}

      {/* AMBER: total silence */}
      {stats && stats.push24 === 0 && stats.poll24 === 0 && (
        <div className="mt-4 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-xs">
            <div className="font-medium text-amber-700 dark:text-amber-400">No sync activity in the last 24h.</div>
            <div className="mt-1 text-muted-foreground">
              Neither push nor poll has fired. The cron job that calls <span className="font-mono">/api/public/gmail-poll</span> may be paused, or the worker route is failing.
            </div>
          </div>
        </div>
      )}

      {/* GREEN: push healthy */}
      {pushHealthy && (
        <div className="mt-4 flex gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <div className="text-xs">
            <div className="font-medium text-emerald-700 dark:text-emerald-400">Push is healthy.</div>
            <div className="mt-1 text-muted-foreground">
              {stats!.push24} pushes in the last 24h, last one {relTime(stats!.lastPushAt)}. New mail is arriving in real time.
            </div>
          </div>
        </div>
      )}

      {/* INFO: poll is covering for missing push */}
      {stats && !pushHealthy && stats.poll24 > 0 && (
        <div className="mt-4 flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          <div className="text-xs">
            <div className="font-medium text-blue-700 dark:text-blue-400">Fallback poll is keeping mail flowing.</div>
            <div className="mt-1 text-muted-foreground">
              {stats.poll24} poll runs in the last 24h, {stats.synced24} messages synced. Last poll {stats.lastPollAt ? relTime(stats.lastPollAt) : "—"}. Real-time push is degraded, so new mail shows up with a small delay instead of instantly.
            </div>
          </div>
        </div>
      )}

      {stats && stats.gmailErrors24 > 0 && (
        <div className="mt-4 flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
          <div className="text-xs">
            <div className="font-medium text-blue-700 dark:text-blue-400">
              Gmail API returned {stats.gmailErrors24} transient error{stats.gmailErrors24 === 1 ? "" : "s"} in the last 24h.
            </div>
            <div className="mt-1 text-muted-foreground">
              These are 429 (rate limit) or 5xx responses from Google. The worker auto-retries them with jittered backoff and the first 2 retries are free.
            </div>
          </div>
        </div>
      )}

      {stats && (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
          <Stat label="Push (24h)" value={stats.push24} />
          <Stat label="Poll (24h)" value={stats.poll24} />
          <Stat label="Watch renew (24h)" value={stats.renew24} />
          <Stat label="Accounts matched" value={stats.accounts24} />
          <Stat label="Emails synced" value={stats.synced24} />
          <Stat label="Gmail API errors" value={stats.gmailErrors24} accent={stats.gmailErrors24 > 0 ? "warn" : undefined} />
          <Stat label="Errors" value={stats.errors24} accent={stats.errors24 > 0 ? "danger" : undefined} />
        </div>
      )}

      <div className="mt-3 text-xs text-muted-foreground">
        Last event: {stats?.lastReceivedAt ? `${relTime(stats.lastReceivedAt)} (${new Date(stats.lastReceivedAt).toLocaleString()})` : "never"}
        {stats?.lastPushAt && <> · Last push: {relTime(stats.lastPushAt)}</>}
        {stats?.lastPollAt && <> · Last poll: {relTime(stats.lastPollAt)}</>}
      </div>

      {/* Last push details */}
      {lastPush && (
        <div className="mt-4 rounded-md border bg-muted/20">
          <button
            type="button"
            className="flex w-full items-center justify-between p-3 text-left text-sm font-medium"
            onClick={() => setShowLastPush((v) => !v)}
          >
            <span className="flex flex-wrap items-center gap-2">
              {showLastPush ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              Last push from Google ({lastPush.event_type})
              <span className="text-xs font-normal text-muted-foreground">— {relTime(lastPush.received_at)}</span>
              {lastPushStale && (
                <Badge variant="outline" className="text-[10px]">
                  stale{lastRenew && lastPushMs < lastRenewMs ? " · before last re-arm" : ""}
                </Badge>
              )}
            </span>
          </button>
          {showLastPush && (
            <div className="border-t p-3 text-xs">
              <div className="grid gap-2 md:grid-cols-2">
                <Detail k="emailAddress (decoded)" v={lastPush.email_address ?? "(missing)"} bad={!lastPush.email_address} />
                <Detail k="historyId (decoded)" v={lastPush.history_id ?? "(missing)"} bad={!lastPush.history_id} />
                <Detail k="accounts_matched" v={String(lastPush.accounts_matched ?? 0)} bad={(lastPush.accounts_matched ?? 0) === 0} />
                <Detail k="Pub/Sub messageId" v={lastPush.message_id ?? "—"} />
                <Detail k="Pub/Sub publishTime" v={lastPush.publish_time ?? "—"} />
                <Detail k="Pub/Sub subscription" v={lastPush.subscription ?? "—"} mono />
              </div>
              {lastPush.details && (
                <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                  {lastPush.details}
                </div>
              )}
              {lastPush.payload != null && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground">Raw decoded payload</summary>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded border bg-card p-2 text-[11px]">
{JSON.stringify(lastPush.payload, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}

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
                    <td className="p-2 text-right">{e.accounts_matched ?? "—"}</td>
                    <td className="p-2 text-right">{e.synced_count ?? "—"}</td>
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

      <div className="mt-6 rounded-md border bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Activity className="h-4 w-4" />
          Push subscription diagnostics
        </div>
        {lastRenew && (
          <div className="mt-3 rounded border border-blue-500/30 bg-blue-500/5 p-2 text-xs">
            <div className="font-medium text-blue-700 dark:text-blue-400">
              Watch re-armed {relTime(lastRenew.received_at)}
              {lastPushMs > lastRenewMs && lastPush?.event_type === "push" && (lastPush.accounts_matched ?? 0) > 0 && (
                <span className="ml-2 text-emerald-700 dark:text-emerald-400">· verified by a fresh matched push ✓</span>
              )}
            </div>
            {lastRenew.details && (
              <div className="mt-0.5 text-muted-foreground break-all">{lastRenew.details}</div>
            )}
            {!(lastPushMs > lastRenewMs && lastPush?.event_type === "push" && (lastPush.accounts_matched ?? 0) > 0) && (
              <div className="mt-1 text-muted-foreground">
                <strong>How to verify:</strong> send yourself an email from another account, then watch this panel for ~30s. A new <span className="font-mono">push</span> row with <span className="font-mono">accounts_matched ≥ 1</span> means real-time push is working. If only <span className="font-mono">poll</span> rows show up, the GCP subscription is the broken piece.
              </div>
            )}
          </div>
        )}
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
                } catch (e: any) {
                  toast.error(e.message);
                } finally {
                  setPinging(null);
                }
              }}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${pinging === mode ? "animate-spin" : ""}`} />
              {mode === "empty" ? "Test webhook reachable" : "Test with connected account"}
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
              GMAIL_PUBSUB_TOPIC: {pingResult.topic_set ? "set" : <span className="text-destructive">not set</span>}
              {pingResult.error && <span className="text-destructive"> · {pingResult.error}</span>}
            </div>
          )}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          These are app-side tests, logged as <span className="font-mono">webhook_test</span> — they prove our endpoint works but do NOT prove the Google Cloud Pub/Sub subscription is delivering. Only a real <span className="font-mono">push</span> row from Google does that.
          {lastWebhookTest && <> · Last test: {relTime(lastWebhookTest.received_at)}</>}
        </p>

        <div className="mt-4 rounded border bg-card p-3 text-xs">
          <div className="font-medium">Google Cloud Pub/Sub setup checklist</div>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>
              Topic name must equal{" "}
              <span className="font-mono">{diag?.pubsubTopic ?? "(GMAIL_PUBSUB_TOPIC not set)"}</span>
              {diag?.pubsubTopic && <> <CopyBtn value={diag.pubsubTopic} /></>}
            </li>
            <li>
              A <strong>push</strong> subscription on that topic must POST to{" "}
              <span className="font-mono">{diag?.webhookUrl}</span>
              {diag?.webhookUrl && <> <CopyBtn value={diag.webhookUrl} /></>}
            </li>
            <li>
              <span className="font-mono">gmail-api-push@system.gserviceaccount.com</span> must have <span className="font-mono">roles/pubsub.publisher</span> on the topic.
            </li>
            <li>Subscription must not be paused; ack deadline ≥ 10s.</li>
            <li>The Gmail watch must be re-armed against the same topic as the subscription (use the button above).</li>
          </ol>
        </div>

        <p className="mt-2 text-[11px] text-muted-foreground">
          A successful test means our endpoint accepts pushes — if real pushes are still missing, work down the checklist above.
        </p>
      </div>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "danger" | "warn" }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${accent === "danger" ? "text-destructive" : accent === "warn" ? "text-amber-600" : ""}`}>{value}</div>
    </div>
  );
}

function Detail({ k, v, mono, bad }: { k: string; v: string; mono?: boolean; bad?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
      <div className={`${mono ? "font-mono" : ""} ${bad ? "text-destructive" : ""} break-all`}>{v}</div>
    </div>
  );
}
