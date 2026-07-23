import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  RotateCcw,
  Stethoscope,
  RefreshCw,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  getAccountHealth,
  retryDlqJobs,
  runAccountDiagnostic,
} from "@/lib/account-health.functions";
import { startConnectGmail } from "@/lib/gmail.functions";
import { DlqDrawer } from "./DlqDrawer";

function fmtRelative(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) {
    const future = -ms;
    if (future < 60_000) return `in ${Math.round(future / 1000)}s`;
    if (future < 3600_000) return `in ${Math.round(future / 60_000)}m`;
    if (future < 86_400_000) return `in ${Math.round(future / 3600_000)}h`;
    return `in ${Math.round(future / 86_400_000)}d`;
  }
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function AccountHealthPanel({ accountId }: { accountId: string | null }) {
  const qc = useQueryClient();
  const fetchHealth = useServerFn(getAccountHealth);
  const retryAll = useServerFn(retryDlqJobs);
  const diagnose = useServerFn(runAccountDiagnostic);
  const startConnect = useServerFn(startConnectGmail);
  const [drawerAccount, setDrawerAccount] = useState<{ id: string; email: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState<string | null>(null);
  const [reconnectBusy, setReconnectBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["account-health"],
    queryFn: () => fetchHealth(),
    refetchInterval: 15_000,
  });

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border p-4 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" /> Loading account health…
      </div>
    );
  }

  const allAccounts = q.data?.accounts ?? [];
  const accounts = accountId ? allAccounts.filter((a) => a.accountId === accountId) : allAccounts;
  if (accounts.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {allAccounts.length === 0
          ? "No Gmail accounts connected yet."
          : "Pick an inbox above to see its status."}
      </div>
    );
  }

  async function handleRetryAll(accountId: string) {
    setBusy(accountId);
    try {
      const r = await retryAll({ data: { account_id: accountId } });
      toast.success(`Requeued ${r.requeued} failed job${r.requeued === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["account-health"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleDiagnose(accountId: string) {
    setDiagBusy(accountId);
    try {
      const r = await diagnose({ data: { account_id: accountId } });
      if (r.accessToken === "needs_reconnect") {
        toast.error("Reconnect required: " + (r.error ?? "OAuth token expired"));
      } else if (r.accessToken === "error" || r.watch === "error") {
        toast.error(r.error ?? "Diagnostic failed");
      } else {
        toast.success(
          `OAuth ok · watch ${r.watch}${r.watchExpiresAt ? " · " + fmtRelative(r.watchExpiresAt) : ""}`,
        );
      }
      qc.invalidateQueries({ queryKey: ["account-health"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDiagBusy(null);
    }
  }

  async function handleReconnect(accountId: string, email: string) {
    setReconnectBusy(accountId);
    try {
      const r = await startConnect({ data: { login_hint: email } });
      window.location.href = r.url;
    } catch (e) {
      toast.error((e as Error).message);
      setReconnectBusy(null);
    }
  }

  return (
    <>
      <div className="space-y-3">
        {accounts.map((a) => {
          const watchExp = a.watchExpiresAt ? new Date(a.watchExpiresAt) : null;
          const watchActive = watchExp && watchExp > new Date();
          const watchSoon = watchExp && watchExp.getTime() - Date.now() < 24 * 60 * 60 * 1000;
          const dlqColor = a.dlq === 0 ? "text-muted-foreground" : "text-destructive";

          return (
            <div
              key={a.accountId}
              className={`rounded-md border p-4 ${a.needsReconnect ? "border-destructive/40 bg-destructive/5" : "border-border"}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{a.email}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" /> poll {fmtRelative(a.lastPollAt)}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Activity className="h-3 w-3" /> push {fmtRelative(a.lastPushAt)}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 ${watchActive ? "" : "text-destructive"}`}
                    >
                      {watchActive ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      watch {watchActive ? (watchSoon ? "expiring " : "renews ") : "expired "}
                      {a.watchExpiresAt ? fmtRelative(a.watchExpiresAt) : "—"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded border border-border/60 px-2 py-1.5">
                  <div className="text-base font-medium">{a.pending}</div>
                  <div className="text-muted-foreground">Pending</div>
                </div>
                <div className="rounded border border-border/60 px-2 py-1.5">
                  <div className="text-base font-medium">{a.running}</div>
                  <div className="text-muted-foreground">Running</div>
                </div>
                <div className="rounded border border-border/60 px-2 py-1.5">
                  <div className={`text-base font-medium ${dlqColor}`}>{a.dlq}</div>
                  <div className="text-muted-foreground">Failed</div>
                </div>
              </div>

              {a.lastError && (
                <div className="mt-3 rounded border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <span className="font-medium">Recent error:</span>{" "}
                  <span className="break-words">{a.lastError}</span>
                </div>
              )}

              {a.needsReconnect && (
                <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
                  <div className="flex items-start gap-2 text-destructive">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">Gmail disconnected — reconnect required</div>
                      <div className="mt-0.5 text-destructive/80 break-words">
                        {a.lastOauthError ??
                          "OAuth refresh token is invalid or missing. Sync is paused for this account."}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => handleReconnect(a.accountId, a.email)}
                      disabled={reconnectBusy === a.accountId}
                    >
                      <RefreshCw className="mr-1.5 h-3 w-3" />
                      {reconnectBusy === a.accountId ? "Redirecting…" : "Reconnect Gmail"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDiagnose(a.accountId)}
                  disabled={diagBusy === a.accountId}
                >
                  <Stethoscope className="mr-1.5 h-3 w-3" />
                  {diagBusy === a.accountId ? "Running…" : "Run diagnostic"}
                </Button>
                {a.dlq > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRetryAll(a.accountId)}
                      disabled={busy === a.accountId}
                    >
                      <RotateCcw className="mr-1.5 h-3 w-3" />
                      {busy === a.accountId ? "Requeuing…" : `Retry all (${a.dlq})`}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDrawerAccount({ id: a.accountId, email: a.email })}
                    >
                      <Inbox className="mr-1.5 h-3 w-3" /> Inspect
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {drawerAccount && (
        <DlqDrawer
          accountId={drawerAccount.id}
          email={drawerAccount.email}
          open={!!drawerAccount}
          onClose={() => setDrawerAccount(null)}
        />
      )}
    </>
  );
}
