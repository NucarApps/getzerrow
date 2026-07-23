import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listMessageJobs, retryJob, runJobsNow } from "@/lib/gmail.functions";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, PlayCircle, AlertCircle } from "lucide-react";
import { toast } from "sonner";

type StatusFilter = "all" | "pending" | "running" | "dlq";

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 0) return `in ${Math.abs(s)}s`;
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ProcessingJobs({ accountId }: { accountId: string | null }) {
  const fetchJobs = useServerFn(listMessageJobs);
  const retryFn = useServerFn(retryJob);
  const runNow = useServerFn(runJobsNow);
  const [filter, setFilter] = useState<StatusFilter>("dlq");
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["message-jobs", filter, accountId],
    queryFn: () =>
      fetchJobs({ data: { status: filter, limit: 200, account_id: accountId ?? undefined } }),
    refetchInterval: 5000,
  });

  const jobs = q.data?.jobs ?? [];
  const stats = q.data?.stats;

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-col gap-3 border-b bg-muted/20 p-4 md:flex-row md:items-start md:justify-between md:p-6">
        <div>
          <h2 className="font-display text-2xl">Processing queue</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every incoming email becomes a job. Failures retry with backoff (30s → 2m → 10m → 30m →
            2h), then dead-letter after 5 attempts.
          </p>
        </div>
        <div className="flex gap-2 self-start md:self-auto">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await runNow({ data: { limit: 50 } });
                toast.success(
                  `Processed ${r.processed} jobs (${r.ok} ok, ${r.failed} retry, ${r.dlq} dead-lettered)`,
                );
                q.refetch();
              } catch (e: unknown) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <PlayCircle className={`mr-2 h-4 w-4 ${busy ? "animate-pulse" : ""}`} />
            Run worker now
          </Button>
          <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="space-y-4 p-4 md:p-6">
        {stats && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Total" value={stats.total} />
            <Stat label="Pending" value={stats.pending} />
            <Stat label="Running" value={stats.running} />
            <Stat
              label="Dead-letter"
              value={stats.dlq}
              accent={stats.dlq > 0 ? "danger" : undefined}
            />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Jobs</h3>
          <div className="flex flex-wrap gap-1.5">
            {(["dlq", "pending", "running", "all"] as StatusFilter[]).map((f) => (
              <Button
                key={f}
                size="sm"
                variant={filter === f ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => setFilter(f)}
              >
                {f === "all"
                  ? "All"
                  : f === "dlq"
                    ? "Dead-letter"
                    : f[0].toUpperCase() + f.slice(1)}
              </Button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <Table className="w-full text-xs">
            <TableHeader className="bg-muted/50 text-left">
              <TableRow>
                <TableHead className="p-2">Status</TableHead>
                <TableHead className="p-2">From</TableHead>
                <TableHead className="p-2">Subject</TableHead>
                <TableHead className="p-2 text-right">Attempt</TableHead>
                <TableHead className="p-2">Next run</TableHead>
                <TableHead className="p-2">Last error</TableHead>
                <TableHead className="p-2"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="p-4 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!q.isLoading && jobs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="p-4 text-center text-muted-foreground">
                    {filter === "dlq" ? "No dead-lettered jobs. 🎉" : "Queue is empty."}
                  </TableCell>
                </TableRow>
              )}
              {jobs.map((j) => (
                <TableRow key={j.id} className="border-t hover:bg-muted/30">
                  <TableCell className="p-2">
                    <Badge
                      variant={
                        j.status === "dlq"
                          ? "destructive"
                          : j.status === "running"
                            ? "default"
                            : "secondary"
                      }
                      className="text-[10px]"
                    >
                      {j.status === "dlq" && <AlertCircle className="mr-1 h-3 w-3" />}
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="p-2 max-w-[180px] truncate">
                    {j.from_addr ?? (
                      <span className="text-muted-foreground font-mono">
                        {j.gmail_message_id.slice(0, 10)}…
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="p-2 max-w-[260px] truncate">{j.subject ?? "—"}</TableCell>
                  <TableCell className="p-2 text-right">{j.attempt}/5</TableCell>
                  <TableCell className="p-2 whitespace-nowrap" title={j.next_run_at}>
                    {relTime(j.next_run_at)}
                  </TableCell>
                  <TableCell
                    className="p-2 max-w-[280px] truncate text-destructive"
                    title={j.last_error ?? ""}
                  >
                    {j.last_error ?? ""}
                  </TableCell>
                  <TableCell className="p-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await retryFn({ data: { id: j.id } });
                          toast.success("Re-queued");
                          q.refetch();
                        } catch (e: unknown) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      Retry
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: "danger" }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-xl font-semibold ${accent === "danger" ? "text-destructive" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}
