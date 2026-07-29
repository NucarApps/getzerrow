import { useState } from "react";
import { useQuery, useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Forward } from "lucide-react";
import { toast } from "sonner";
import {
  backfillOriginSenders,
  getOriginBackfillStatus,
} from "@/lib/gmail/origin-backfill.functions";

/**
 * Re-reads recent mail from Gmail to recover the true sender behind relayed
 * messages (e.g. "Manheim via Old User Ken Connor"). Runs in bounded batches
 * so a large mailbox never blows the request budget.
 */
export function ForwardedMailBackfill() {
  const statusFn = useServerFn(getOriginBackfillStatus);
  const backfillFn = useServerFn(backfillOriginSenders);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ scanned: number; updated: number } | null>(null);
  const [status, setStatus] = useState<{ pending: number; forwarded: number } | null>(null);

  async function loadStatus() {
    try {
      setStatus(await statusFn({}));
    } catch {
      setStatus(null);
    }
  }

  async function run() {
    setRunning(true);
    let scanned = 0;
    let updated = 0;
    let before: string | null = null;
    try {
      for (let batch = 0; batch < 40; batch++) {
        const r = await backfillFn({ data: { before, days: 90, limit: 150 } });
        scanned += r.scanned;
        updated += r.updated;
        setProgress({ scanned, updated });
        if (r.done || !r.next_before) break;
        before = r.next_before;
      }
      toast.success(
        updated > 0
          ? `Recovered the original sender on ${updated} message${updated === 1 ? "" : "s"}`
          : "No relayed mail needed updating",
      );
      void loadStatus();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start gap-3">
        <Forward className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Forwarded and relayed mail</h3>
          <p className="text-xs text-muted-foreground">
            Mail that arrives through a group or a former colleague's forwarding address shows the
            forwarder as the sender. Rescan the last 90 days to recover the original sender so your
            filters can target it.
          </p>
          {status && (
            <p className="text-xs text-muted-foreground">
              {status.forwarded} relayed message{status.forwarded === 1 ? "" : "s"} identified ·{" "}
              {status.pending} still to check
            </p>
          )}
          {progress && (
            <p className="text-xs text-muted-foreground">
              Scanned {progress.scanned} · updated {progress.updated}
            </p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={run} disabled={running}>
          {running ? "Rescanning…" : "Rescan for original senders"}
        </Button>
        <Button size="sm" variant="outline" onClick={loadStatus} disabled={running}>
          Check status
        </Button>
      </div>
    </Card>
  );
}
