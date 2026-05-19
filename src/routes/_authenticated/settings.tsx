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

  const stateQ = useQuery({ queryKey: ["sync-state"], queryFn: () => getState() });
  const [busy, setBusy] = useState<string | null>(null);

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
          <p className="mt-4 text-xs text-muted-foreground">
            Note: Real-time Gmail push (Pub/Sub watch) isn't available through the shared Lovable Gmail connector — use "Sync now" or schedule a periodic poll instead.
          </p>
        </Card>
      </div>
    </div>
  );
}
