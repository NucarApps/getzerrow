import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { getAccountHealth } from "@/lib/account-health.functions";
import { startConnectGmail } from "@/lib/gmail.functions";

export function ReconnectBanner() {
  const fetchHealth = useServerFn(getAccountHealth);
  const startConnect = useServerFn(startConnectGmail);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["account-health"],
    queryFn: () => fetchHealth(),
    refetchInterval: 60_000,
  });

  const affected = (q.data?.accounts ?? []).filter((a) => a.needsReconnect);
  if (dismissed || affected.length === 0) return null;

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

  return (
    <div className="border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm">
      <div className="mx-auto flex max-w-5xl items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-destructive">
            {affected.length === 1
              ? `Gmail disconnected for ${affected[0].email} — new mail won't arrive live until you reconnect.`
              : `${affected.length} inboxes disconnected — new mail won't arrive live until you reconnect.`}
          </div>
          <div className="mt-2 flex flex-col gap-2">
            {affected.map((a) => (
              <div key={a.accountId} className="flex flex-wrap items-center gap-2">
                {affected.length > 1 && (
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
  );
}
