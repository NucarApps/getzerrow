import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  listMyGmailAccounts, startConnectGmail, disconnectGmailAccount,
  triggerBackfill, triggerSync, renewGmailWatch,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import { Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { InboxOverrides } from "@/components/settings/InboxOverrides";
import { PubsubActivity } from "@/components/settings/PubsubActivity";
import { ProcessingJobs } from "@/components/settings/ProcessingJobs";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const qc = useQueryClient();
  const listAccounts = useServerFn(listMyGmailAccounts);
  const connect = useServerFn(startConnectGmail);
  const disconnect = useServerFn(disconnectGmailAccount);
  const backfill = useServerFn(triggerBackfill);
  const sync = useServerFn(triggerSync);
  const renew = useServerFn(renewGmailWatch);

  const accountsQ = useQuery({ queryKey: ["gmail-accounts"], queryFn: () => listAccounts() });
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<any>, msg: string) {
    setBusy(key);
    try { await fn(); toast.success(msg); qc.invalidateQueries({ queryKey: ["gmail-accounts"] }); qc.invalidateQueries({ queryKey: ["emails"] }); }
    catch (e: any) { toast.error(e.message); }
    setBusy(null);
  }

  async function startConnect() {
    setBusy("connect");
    try {
      const { url } = await connect();
      window.location.href = url;
    } catch (e: any) { toast.error(e.message); setBusy(null); }
  }

  const accounts = accountsQ.data?.accounts ?? [];

  return (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="font-display text-3xl md:text-4xl">Settings</h1>

        <Card className="p-4 md:p-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-display text-2xl">Connected Gmail accounts</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your Gmail is connected automatically when you sign in with Google. Use "Reauthorize" if scopes change.
              </p>
            </div>
            {accounts.length === 0 && (
              <Button onClick={startConnect} disabled={busy !== null} className="self-start md:self-auto">
                <Plus className="mr-1.5 h-4 w-4" />{busy === "connect" ? "Redirecting…" : "Reauthorize Gmail"}
              </Button>
            )}
          </div>

          <div className="mt-6 space-y-3">
            {accounts.length === 0 && (
              <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No Gmail connected yet. Sign out and sign back in with Google, or click "Reauthorize Gmail".
              </p>
            )}
            {accounts.map((a) => {
              const exp = a.watch_expiration ? new Date(a.watch_expiration) : null;
              const watchActive = exp && exp > new Date();
              return (
                <div key={a.id} className="rounded-md border border-border p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{a.email_address}</div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        {watchActive ? (
                          <><CheckCircle2 className="h-3 w-3 text-primary" />Real-time push active · renews {exp!.toLocaleDateString()}</>
                        ) : (
                          <><AlertCircle className="h-3 w-3" />No active push watch</>
                        )}
                        {a.last_poll_at && <span>· last synced {new Date(a.last_poll_at).toLocaleString()}</span>}
                      </div>
                    </div>
                    <Button size="icon" variant="ghost" onClick={() => run(`del-${a.id}`, () => disconnect({ data: { account_id: a.id } }), "Disconnected")} disabled={busy !== null}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => run(`bf-${a.id}`, () => backfill({ data: { account_id: a.id, count: 30 } }), "Backfilled latest 30")} disabled={busy !== null}>
                      {busy === `bf-${a.id}` ? "Backfilling…" : "Backfill recent 30"}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => run(`sync-${a.id}`, () => sync({ data: { account_id: a.id } }), "Synced")} disabled={busy !== null}>
                      <RefreshCw className="mr-1.5 h-3 w-3" />{busy === `sync-${a.id}` ? "Syncing…" : "Sync now"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => run(`watch-${a.id}`, () => renew({ data: { account_id: a.id } }), "Watch renewed")} disabled={busy !== null}>
                      {busy === `watch-${a.id}` ? "Renewing…" : "Renew push watch"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <InboxOverrides />
        <PubsubActivity />
        <ProcessingJobs />


      </div>
    </div>
  );
}
