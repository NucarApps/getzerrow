import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RotateCcw, Trash2 } from "lucide-react";
import { Spinner, SpinnerLabel } from "@/components/ui/spinner";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { listDlqJobs, retryDlqJob, deleteDlqJob } from "@/lib/account-health.functions";

type Props = {
  accountId: string;
  email: string;
  open: boolean;
  onClose: () => void;
};

export function DlqDrawer({ accountId, email, open, onClose }: Props) {
  const qc = useQueryClient();
  const fetchRows = useServerFn(listDlqJobs);
  const retryOne = useServerFn(retryDlqJob);
  const deleteOne = useServerFn(deleteDlqJob);
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["dlq-jobs", accountId],
    queryFn: () => fetchRows({ data: { account_id: accountId } }),
    enabled: open,
  });

  async function handleRetry(jobId: string) {
    setBusy(jobId);
    try {
      await retryOne({ data: { job_id: jobId } });
      toast.success("Requeued");
      qc.invalidateQueries({ queryKey: ["dlq-jobs", accountId] });
      qc.invalidateQueries({ queryKey: ["account-health"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleDelete(jobId: string) {
    setBusy(jobId);
    try {
      await deleteOne({ data: { job_id: jobId } });
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["dlq-jobs", accountId] });
      qc.invalidateQueries({ queryKey: ["account-health"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Failed messages</SheetTitle>
          <SheetDescription>{email}</SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-3">
          {q.isLoading && <SpinnerLabel>Loading…</SpinnerLabel>}
          {q.data && q.data.rows.length === 0 && (
            <p className="text-sm text-muted-foreground">No failed messages.</p>
          )}
          {q.data?.rows.map((r) => (
            <div key={r.id} className="rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{r.subject || "(no subject)"}</div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {r.fromAddr || "—"}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleRetry(r.id)}
                    disabled={busy === r.id}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleDelete(r.id)}
                    disabled={busy === r.id}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>Attempts: {r.attempt}</span>
                <span>{new Date(r.updatedAt).toLocaleString()}</span>
              </div>
              {r.lastError && (
                <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
                  {r.lastError}
                </div>
              )}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
