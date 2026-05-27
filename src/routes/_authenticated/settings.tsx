import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  listMyGmailAccounts, startConnectGmail, disconnectGmailAccount,
  triggerBackfill, triggerWeekBackfill, triggerSync, renewGmailWatch,
  startDeepBackfill, cancelDeepBackfill, getBackfillStatus,
} from "@/lib/gmail.functions";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Plus, Trash2, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { InboxOverrides } from "@/components/settings/InboxOverrides";
import { PubsubActivity } from "@/components/settings/PubsubActivity";
import { ProcessingJobs } from "@/components/settings/ProcessingJobs";
import { AccountHealthPanel } from "@/components/settings/AccountHealthCard";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { useAccountSelection } from "@/lib/account-selection";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const qc = useQueryClient();
  const listAccounts = useServerFn(listMyGmailAccounts);
  const connect = useServerFn(startConnectGmail);
  const disconnect = useServerFn(disconnectGmailAccount);
  const backfill = useServerFn(triggerBackfill);
  const weekBackfill = useServerFn(triggerWeekBackfill);
  const sync = useServerFn(triggerSync);
  const renew = useServerFn(renewGmailWatch);
  const startDeep = useServerFn(startDeepBackfill);
  const cancelDeep = useServerFn(cancelDeepBackfill);
  const getStatus = useServerFn(getBackfillStatus);

  const accountsQ = useQuery({ queryKey: ["gmail-accounts"], queryFn: () => listAccounts() });
  const backfillQ = useQuery({
    queryKey: ["backfill-status"],
    queryFn: async () => (await getStatus({ data: {} })).job as any,
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const { activeAccountId, setActiveAccountId } = useAccountSelection();
  const [scopedEmail, setScopedEmail] = useState<string | null>(null);


  async function run(key: string, fn: () => Promise<any>, msg: string) {
    setBusy(key);
    try { await fn(); if (msg) toast.success(msg); qc.invalidateQueries({ queryKey: ["gmail-accounts"] }); qc.invalidateQueries({ queryKey: ["emails"] }); }
    catch (e: any) { toast.error(e.message); }
    setBusy(null);
  }

  async function startConnect(loginHint?: string) {
    setBusy(loginHint ? `reconnect-${loginHint}` : "connect");
    try {
      const { url } = await connect({ data: loginHint ? { login_hint: loginHint } : {} });
      window.location.href = url;
    } catch (e: any) { toast.error(e.message); setBusy(null); }
  }

  const accounts = accountsQ.data?.accounts ?? [];

  return (
    <div className="h-full overflow-y-auto p-4 md:p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="font-display text-3xl md:text-4xl">Settings</h1>

        <Tabs defaultValue="accounts" className="space-y-6">
          <TabsList className="bg-transparent p-0 h-auto gap-6 border-b border-border rounded-none w-full justify-start">
            <TabsTrigger value="accounts" className="bg-transparent rounded-none px-0 pb-3 pt-0 border-b-2 border-transparent text-muted-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:border-primary data-[state=active]:shadow-none">Accounts</TabsTrigger>
            <TabsTrigger value="filters" className="bg-transparent rounded-none px-0 pb-3 pt-0 border-b-2 border-transparent text-muted-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:border-primary data-[state=active]:shadow-none">Inbox filters</TabsTrigger>
            <TabsTrigger value="activity" className="bg-transparent rounded-none px-0 pb-3 pt-0 border-b-2 border-transparent text-muted-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:border-primary data-[state=active]:shadow-none">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="accounts" className="space-y-6">
            <Card className="p-4 md:p-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="font-display text-2xl">Connected Gmail accounts</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Connect multiple Gmail inboxes and switch between them from the inbox header.
                  </p>
                </div>
                <Button onClick={() => startConnect()} disabled={busy !== null} className="self-start md:self-auto">
                  <Plus className="mr-1.5 h-4 w-4" />{busy === "connect" ? "Redirecting…" : accounts.length === 0 ? "Connect Gmail" : "Add another Gmail"}
                </Button>
              </div>

              <div className="mt-6 space-y-3">
                {accounts.length === 0 && (
                  <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                    No Gmail connected yet. Sign out and sign back in with Google, or click "Connect Gmail".
                  </p>
                )}
                {accounts.map((a) => {
                  const exp = a.watch_expiration ? new Date(a.watch_expiration) : null;
                  const watchActive = exp && exp > new Date();
                  const bf = backfillQ.data && backfillQ.data.gmail_account_id === a.id ? backfillQ.data : null;
                  const bfActive = bf && (bf.status === "listing" || bf.status === "processing");
                  return (
                    <div key={a.id} className="rounded-md border border-border p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{a.email_address}</span>
                            {a.needs_reauth && (
                              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                                Reconnect required
                              </span>
                            )}
                          </div>
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
                        {a.needs_reauth && (
                          <Button size="sm" variant="default" onClick={() => startConnect(a.email_address)} disabled={busy !== null}>
                            {busy === `reconnect-${a.email_address}` ? "Redirecting…" : "Reconnect"}
                          </Button>
                        )}
                        <Button size="sm" onClick={() => run(`bf-${a.id}`, () => backfill({ data: { account_id: a.id, count: 30 } }), "Backfilled latest 30")} disabled={busy !== null}>
                          {busy === `bf-${a.id}` ? "Backfilling…" : "Backfill recent 30"}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => run(`week-${a.id}`, async () => {
                          const r: any = await weekBackfill({ data: { account_id: a.id, days: 7, max: 1000 } });
                          toast.success(`Pulled ${r?.processed ?? 0} new messages from the last 7 days (${r?.alreadyHad ?? 0} already in sync)`);
                        }, "")} disabled={busy !== null}>
                          {busy === `week-${a.id}` ? "Catching up…" : "Catch up last 7 days"}
                        </Button>
                        {!bfActive ? (
                          <Button size="sm" variant="default" onClick={() => run(`deep-${a.id}`, async () => {
                            const r: any = await startDeep({ data: { account_id: a.id, months: 6 } });
                            qc.invalidateQueries({ queryKey: ["backfill-status"] });
                            toast.success(r?.reused ? "Import already running — banner will update with progress" : "Started importing your last 6 months of email");
                          }, "")} disabled={busy !== null}>
                            {busy === `deep-${a.id}` ? "Starting…" : "Pull last 6 months"}
                          </Button>
                        ) : (
                          <Button size="sm" variant="destructive" onClick={() => run(`cancel-${a.id}`, async () => {
                            await cancelDeep({ data: { job_id: bf!.id } });
                            qc.invalidateQueries({ queryKey: ["backfill-status"] });
                            toast.success("Import canceled — already-pulled emails are kept");
                          }, "")} disabled={busy !== null}>
                            {busy === `cancel-${a.id}` ? "Canceling…" : "Cancel import"}
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => run(`sync-${a.id}`, () => sync({ data: { account_id: a.id } }), "Synced")} disabled={busy !== null}>
                          <RefreshCw className="mr-1.5 h-3 w-3" />{busy === `sync-${a.id}` ? "Syncing…" : "Sync now"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => run(`watch-${a.id}`, () => renew({ data: { account_id: a.id } }), "Watch renewed")} disabled={busy !== null}>
                          {busy === `watch-${a.id}` ? "Renewing…" : "Renew push watch"}
                        </Button>
                      </div>
                      {bfActive && (
                        <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                          {bf!.status === "listing"
                            ? `Finding messages… ${bf!.total_found.toLocaleString()} found so far`
                            : `Importing ${bf!.months} months — ${Math.max(0, bf!.total_enqueued - bf!.remaining).toLocaleString()} of ${bf!.total_enqueued.toLocaleString()} done`}
                        </div>
                      )}
                    </div>
                  );
                })}

              </div>
            </Card>
          </TabsContent>

          <TabsContent value="filters" className="space-y-4">
            <AccountPicker
              value={activeAccountId}
              onChange={(id, email) => { setActiveAccountId(id); setScopedEmail(email); }}
              label="Inbox"
            />
            <InboxOverrides accountId={activeAccountId} accountEmail={scopedEmail} />
          </TabsContent>

          <TabsContent value="activity" className="space-y-6">
            <AccountPicker
              value={activeAccountId}
              onChange={(id, email) => { setActiveAccountId(id); setScopedEmail(email); }}
              label="Inbox"
            />
            <Card className="overflow-hidden p-0">
              <div className="border-b bg-muted/20 p-4 md:p-6">
                <h2 className="font-display text-2xl">Account health</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Live status for {scopedEmail ?? "the selected mailbox"} — auto-refreshes every 15 seconds.
                </p>
              </div>
              <div className="p-4 md:p-6">
                <AccountHealthPanel accountId={activeAccountId} />
              </div>
            </Card>
            <PubsubActivity accountId={activeAccountId} accountEmail={scopedEmail} />
            <ProcessingJobs accountId={activeAccountId} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
