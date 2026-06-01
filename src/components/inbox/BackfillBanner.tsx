import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getBackfillStatus } from "@/lib/gmail.functions";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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
  const [now, setNow] = useState(() => Date.now());

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

  // Tick once a second while listing so the "elapsed" hint can appear.
  useEffect(() => {
    if (!job || job.status !== "listing") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [job]);

  // Auto-suppress the "done" banner after a short delay.
  useEffect(() => {
    if (!job) return;
    if (job.status === "done" && dismissed !== job.id) {
      const t = setTimeout(() => setDismissed(job.id), 15000);
      return () => clearTimeout(t);
    }
  }, [job, dismissed]);

  const elapsedSec = useMemo(() => {
    if (!job) return 0;
    return Math.max(0, Math.floor((now - new Date(job.started_at).getTime()) / 1000));
  }, [job, now]);

  if (!job) return null;
  if (job.status === "canceled" || job.status === "error") return null;
  if (job.status === "done" && dismissed === job.id) return null;

  const listing = job.status === "listing";
  const processing = job.status === "processing";
  const active = listing || processing;

  const totalDone = Math.max(0, job.total_enqueued - job.remaining);
  const denom = job.total_enqueued || 1;
  const pct = processing ? Math.min(99, Math.round((totalDone / denom) * 100)) : 100;

  let label: string;
  if (listing) {
    label = `Scanning your last ${job.months} months — ${job.total_found.toLocaleString()} messages found so far. We'll start importing as soon as the scan finishes.`;
  } else if (processing) {
    label = `Importing your last ${job.months} months of email — ${totalDone.toLocaleString()} of ${job.total_enqueued.toLocaleString()} done`;
  } else {
    label = `Import finished — ${job.total_enqueued.toLocaleString()} new messages added`;
  }

  const showSlowHint = listing && elapsedSec > 60;

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
          {listing && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-background/60">
              <div className="h-full w-1/3 animate-[backfill-marquee_1.4s_linear_infinite] rounded-full bg-primary" />
            </div>
          )}
          {processing && (
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-background/60">
              <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          {active && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {showSlowHint
                ? "Large mailbox — this can take a few minutes. You can keep using Zerrow; new emails are still coming in live."
                : "You can keep using Zerrow — new emails are still coming in live."}
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
      <style>{`@keyframes backfill-marquee { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>
    </div>
  );
}
