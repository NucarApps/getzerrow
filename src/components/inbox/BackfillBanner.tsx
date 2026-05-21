import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getBackfillStatus } from "@/lib/gmail.functions";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

type BackfillJob = {
  id: string;
  gmail_account_id: string;
  status: string;
  months: number;
  total_found: number;
  total_enqueued: number;
  already_had: number;
  started_at: string;
  finished_at: string | null;
  remaining: number;
};

export function BackfillBanner() {
  const getStatus = useServerFn(getBackfillStatus);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["backfill-status"],
    queryFn: async () => (await getStatus({ data: {} })).job as BackfillJob | null,
    refetchInterval: (query) => {
      const job = query.state.data;
      if (!job) return 15000;
      if (job.status === "listing" || job.status === "processing") return 5000;
      return 30000;
    },
  });

  const job = q.data;

  // Auto-show "Finished" briefly, then suppress until next active job.
  useEffect(() => {
    if (!job) return;
    if (job.status === "done" && dismissed !== job.id) {
      const t = setTimeout(() => setDismissed(job.id), 15000);
      return () => clearTimeout(t);
    }
  }, [job, dismissed]);

  if (!job) return null;
  if (job.status === "canceled" || job.status === "error") return null;
  if (job.status === "done" && dismissed === job.id) return null;

  const active = job.status === "listing" || job.status === "processing";
  const totalDone = Math.max(0, job.total_enqueued - job.remaining);
  const denom = job.total_enqueued || job.total_found || 1;
  const pct = active ? Math.min(99, Math.round((totalDone / denom) * 100)) : 100;

  const label = active
    ? job.status === "listing"
      ? `Finding messages from the last ${job.months} months — ${job.total_found.toLocaleString()} found so far`
      : `Importing your last ${job.months} months of email — ${totalDone.toLocaleString()} of ${job.total_enqueued.toLocaleString()} done`
    : `Import finished — ${job.total_enqueued.toLocaleString()} new messages added`;

  return (
    <div className="border-b border-border bg-primary/10 px-4 py-2 text-sm">
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        {active ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : (
          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-foreground">{label}</div>
          {active && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-background/60">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {active && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              You can keep using Zerrow — new emails are still coming in live.
            </div>
          )}
        </div>
        {!active && (
          <button
            type="button"
            onClick={() => setDismissed(job.id)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
