import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listFolderSummaries,
  createFolderSummary,
  updateFolderSummary,
  deleteFolderSummary,
  runFolderSummaryNow,
  getFolderSummaryJob,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Clock, Play, Pencil } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import type { Schedule } from "./types";
import { ScheduleForm } from "./folder-schedule-form";
import { pad2 } from "./schedule-utils";

export function SummariesPanel({ folderId }: { folderId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listFolderSummaries);
  const createFn = useServerFn(createFolderSummary);
  const updateFn = useServerFn(updateFolderSummary);
  const deleteFn = useServerFn(deleteFolderSummary);
  const runNowFn = useServerFn(runFolderSummaryNow);
  const getJobFn = useServerFn(getFolderSummaryJob);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["folder-summaries", folderId],
    queryFn: async () => (await listFn({ data: { folder_id: folderId } })).schedules as Schedule[],
  });
  const schedules = q.data ?? [];

  async function toggleEnabled(s: Schedule, enabled: boolean) {
    try {
      await updateFn({ data: { id: s.id, enabled } });
      qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }
  async function remove(s: Schedule) {
    if (!confirm(`Delete summary "${s.name}"?`)) return;
    await deleteFn({ data: { id: s.id } });
    qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
  }
  async function runNow(s: Schedule) {
    setRunningId(s.id);
    const toastId = toast.loading("Generating digest…");
    try {
      const enq = await runNowFn({ data: { id: s.id } });
      const jobId = enq.jobId;
      // Poll up to ~5 minutes (150 * 2s).
      const maxTicks = 150;
      let finished = false;
      for (let i = 0; i < maxTicks; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const { job } = await getJobFn({ data: { id: jobId } });
        if (job.status === "done") {
          const n = job.emails_count ?? 0;
          toast.success(
            n === 0
              ? "Ran — no emails in window"
              : `Inserted digest of ${n} email${n === 1 ? "" : "s"}`,
            { id: toastId },
          );
          finished = true;
          break;
        }
        if (job.status === "failed") {
          toast.error(job.error ?? "Failed", { id: toastId });
          finished = true;
          break;
        }
      }
      if (!finished) {
        toast.error("Still running — check back in a moment", { id: toastId });
      }
      qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed", { id: toastId });
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Clock className="h-3 w-3" /> Daily summaries
        </div>
        {!showForm && !editing && (
          <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add schedule
          </Button>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Zerrow reads emails received in this folder over the last 24 hours and inserts an AI-written
        digest into your inbox at the time you choose.
      </p>

      {q.isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="h-3 w-3" /> Loading…
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {schedules.map((s) =>
            editing?.id === s.id ? (
              <ScheduleForm
                key={s.id}
                initial={s}
                onCancel={() => setEditing(null)}
                onSave={async (vals) => {
                  await updateFn({ data: { id: s.id, ...vals } });
                  setEditing(null);
                  qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
                }}
              />
            ) : (
              <div key={s.id} className="rounded-md border border-border bg-background p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Every day at {pad2(s.hour)}:{pad2(s.minute)} ({s.timezone})
                    </div>
                    {s.instructions && (
                      <div className="mt-1 text-xs text-foreground/70 line-clamp-2">
                        {s.instructions}
                      </div>
                    )}
                    <div className="mt-1.5 text-xs text-muted-foreground">
                      {s.last_run_at
                        ? `Last run: ${new Date(s.last_run_at).toLocaleString()}`
                        : "Not run yet"}
                      {" · "}Next: {new Date(s.next_run_at).toLocaleString()}
                    </div>
                    {s.last_error && (
                      <div className="mt-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                        {s.last_error}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch checked={s.enabled} onCheckedChange={(v) => toggleEnabled(s, v)} />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => runNow(s)}
                      disabled={runningId === s.id}
                      title="Run now"
                      aria-label="Run now"
                    >
                      {runningId === s.id ? (
                        <Spinner className="h-3.5 w-3.5" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        setEditing(s);
                        setShowForm(false);
                      }}
                      title="Edit"
                      aria-label="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => remove(s)}
                      title="Delete"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              </div>
            ),
          )}
          {schedules.length === 0 && !showForm && (
            <div className="text-xs text-muted-foreground italic">No schedules yet.</div>
          )}
          {showForm && (
            <ScheduleForm
              onCancel={() => setShowForm(false)}
              onSave={async (vals) => {
                await createFn({ data: { folder_id: folderId, ...vals } });
                setShowForm(false);
                qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
