import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, RefreshCw, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { getAccountHealth, runAccountDiagnostic } from "@/lib/account-health.functions";
import { startConnectGmail } from "@/lib/gmail.functions";

// A watch that expired (or was never armed) means Gmail push has stopped, so
// new mail no longer classifies within seconds — it falls back to the 2-minute
// poll cron. The account is still authenticated, so this is a softer "paused"
// warning distinct from a full disconnect, with a one-click re-arm.
function isRealtimePaused(watchExpiresAt: string | null): boolean {
  if (!watchExpiresAt) return true;
  return new Date(watchExpiresAt).getTime() <= Date.now();
}

export function ReconnectBanner() {
  const fetchHealth = useServerFn(getAccountHealth);
  const startConnect = useServerFn(startConnectGmail);
  const rearm = useServerFn(runAccountDiagnostic);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["account-health"],
    queryFn: () => fetchHealth(),
    refetchInterval: 60_000,
  });

  const accounts = q.data?.accounts ?? [];
  const disconnected = accounts.filter((a) => a.needsReconnect);
  // Only warn about a paused watch when the account is otherwise healthy —
  // a disconnected account already shows the stronger reconnect prompt.
  const paused = accounts.filter((a) => !a.needsReconnect && isRealtimePaused(a.watchExpiresAt));

  if (dismissed || (disconnected.length === 0 && paused.length === 0)) return null;

  async function handleReconnect(email: string) {
    setBusy(email);
    try {
      const r = await startConnect({ data: { login_hint: email } });
      window.location.href = r.url;
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  }

  async function handleRearm(accountId: string, email: string) {
    setBusy(accountId);
    try {
      const r = await rearm({ data: { account_id: accountId } });
      if (r.watch === "ok") {
        toast.success(`Real-time delivery re-armed for ${email}.`);
        await q.refetch();
      } else if (r.accessToken === "needs_reconnect") {
        toast.error(`${email} needs to be reconnected first.`);
        await q.refetch();
      } else {
        toast.error(r.error ?? `Couldn't re-arm real-time for ${email}.`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {disconnected.length > 0 && (
        <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm">
          <div className="mx-auto flex max-w-5xl items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-destructive">
                {disconnected.length === 1
                  ? `Gmail disconnected for ${disconnected[0].email} — new mail won't arrive live until you reconnect.`
                  : `${disconnected.length} inboxes disconnected — new mail won't arrive live until you reconnect.`}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {disconnected.map((a) => (
                  <div key={a.accountId} className="flex flex-wrap items-center gap-2">
                    {disconnected.length > 1 && (
                      <span className="truncate text-xs text-muted-foreground">{a.email}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleReconnect(a.email)}
                      disabled={busy === a.email}
                      className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
                    >
                      <RefreshCw className="h-3 w-3" />
                      {busy === a.email ? "Redirecting…" : "Reconnect Gmail"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss"
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {paused.length > 0 && (
        <div className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
          <div className="mx-auto flex max-w-5xl items-start gap-3">
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-amber-700 dark:text-amber-400">
                {paused.length === 1
                  ? `Real-time delivery paused for ${paused[0].email} — new mail is still filed, but on a slower fallback until you re-arm.`
                  : `Real-time delivery paused for ${paused.length} inboxes — new mail is still filed, but on a slower fallback until you re-arm.`}
              </div>
              <div className="mt-2 flex flex-col gap-2">
                {paused.map((a) => (
                  <div key={a.accountId} className="flex flex-wrap items-center gap-2">
                    {paused.length > 1 && (
                      <span className="truncate text-xs text-muted-foreground">{a.email}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRearm(a.accountId, a.email)}
                      disabled={busy === a.accountId}
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600/90 disabled:opacity-60"
                    >
                      <Zap className="h-3 w-3" />
                      {busy === a.accountId ? "Re-arming…" : "Re-arm real-time"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss"
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/50 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
