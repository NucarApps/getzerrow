import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { triggerBackfill, triggerSync, getSyncState } from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings")({ component: SettingsPage });

function SettingsPage() {
  const qc = useQueryClient();
  const backfill = useServerFn(triggerBackfill);
  const sync = useServerFn(triggerSync);
  const getState = useServerFn(getSyncState);
  const startWatch = useServerFn(startGmailWatch);
  const stopWatchFn = useServerFn(stopGmailWatch);

  const stateQ = useQuery({ queryKey: ["sync-state"], queryFn: () => getState() });
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const exp = stateQ.data?.watch_expiration ? new Date(stateQ.data.watch_expiration) : null;
  const watchActive = exp && exp > new Date();

  async function run(name: string, fn: () => Promise<any>, msg: string) {
    setBusy(name);
    try { await fn(); toast.success(msg); qc.invalidateQueries({ queryKey: ["sync-state"] }); qc.invalidateQueries({ queryKey: ["emails"] }); }
    catch (e: any) { toast.error(e.message); }
    setBusy(null);
  }

  return (
    <div className="h-screen overflow-y-auto p-8">
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="font-display text-4xl">Settings</h1>

        <Card className="p-6">
          <h2 className="font-display text-2xl">Inbox sync</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Gmail is connected through Lovable. Pull in your recent inbox to start, or sync incrementally afterward.
          </p>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => run("backfill", () => backfill({ data: { count: 30 } }), "Backfilled latest 30")} disabled={busy !== null}>
              {busy === "backfill" ? "Backfilling…" : "Backfill recent 30"}
            </Button>
            <Button variant="outline" onClick={() => run("sync", () => sync(), "Synced")} disabled={busy !== null}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
          </div>
          {stateQ.data?.last_poll_at && (
            <p className="mt-3 text-xs text-muted-foreground">Last polled: {new Date(stateQ.data.last_poll_at).toLocaleString()}</p>
          )}
        </Card>

        <Card className="p-6">
          <h2 className="font-display text-2xl">Real-time push (Gmail → Pub/Sub)</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            For sub-second push, set up a Google Cloud Pub/Sub topic and point it at your webhook. Until then, "Sync now" or a periodic poll covers it.
          </p>

          <div className="mt-4 flex items-center gap-2 text-sm">
            {watchActive ? (
              <><CheckCircle2 className="h-4 w-4 text-primary" />Watch active · expires {exp!.toLocaleString()}</>
            ) : (
              <><AlertCircle className="h-4 w-4 text-muted-foreground" />Not watching</>
            )}
          </div>

          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs uppercase tracking-wider text-muted-foreground">Pub/Sub topic</label>
              <Input placeholder="projects/your-gcp-project/topics/zerrow-gmail" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button onClick={() => run("watch", () => startWatch({ data: { topic } }), "Watch started")} disabled={busy !== null || !topic}>
                Start watching
              </Button>
              {watchActive && (
                <Button variant="outline" onClick={() => run("stop", () => stopWatchFn(), "Watch stopped")} disabled={busy !== null}>
                  Stop watching
                </Button>
              )}
            </div>
          </div>

          <details className="mt-5 rounded-md border border-border bg-card/50 p-4 text-sm">
            <summary className="cursor-pointer text-foreground">How to set up Pub/Sub (one-time, ~5 min)</summary>
            <ol className="mt-3 list-decimal space-y-2 pl-5 text-muted-foreground">
              <li>In <a className="text-primary underline" href="https://console.cloud.google.com" target="_blank" rel="noreferrer">Google Cloud Console</a>, create (or pick) a project and create a Pub/Sub topic named <code className="rounded bg-muted px-1">zerrow-gmail</code>.</li>
              <li>On that topic, grant <code className="rounded bg-muted px-1">gmail-api-push@system.gserviceaccount.com</code> the <em>Pub/Sub Publisher</em> role.</li>
              <li>Create a <strong>Push subscription</strong> with endpoint:<br /><code className="break-all rounded bg-muted px-1">{typeof window !== "undefined" ? window.location.origin : ""}/api/public/gmail-webhook</code></li>
              <li>Paste the full topic path above (e.g. <code className="rounded bg-muted px-1">projects/my-gcp/topics/zerrow-gmail</code>) and hit <em>Start watching</em>.</li>
              <li>Gmail watches expire after ~7 days — re-click <em>Start watching</em> to renew, or wire it to a daily cron.</li>
            </ol>
          </details>
        </Card>
      </div>
    </div>
  );
}
