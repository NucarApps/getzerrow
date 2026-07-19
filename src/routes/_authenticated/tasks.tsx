import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listTasks,
  createTask,
  completeTask,
  reopenTask,
  dismissTask,
  deleteTask,
  confirmCompletionSuggestion,
  dismissCompletionSuggestion,
} from "@/lib/tasks.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Circle, Trash2, Sparkles, Video, Mail, Plus, X } from "lucide-react";

export const Route = createFileRoute("/_authenticated/tasks")({
  head: () => ({
    meta: [
      { title: "Tasks — Zerrow" },
      {
        name: "description",
        content: "Your action items, added manually or extracted from meetings and email.",
      },
    ],
  }),
  component: TasksPage,
});

type StatusFilter = "open" | "done" | "dismissed" | "all";
type SourceFilter = "all" | "manual" | "meeting" | "email";

function TasksPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("open");
  const [source, setSource] = useState<SourceFilter>("all");
  const [newTitle, setNewTitle] = useState("");

  const listFn = useServerFn(listTasks);
  const q = useQuery({
    queryKey: ["tasks", status, source],
    queryFn: () => listFn({ data: { status, source } }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["tasks"] });

  const createFn = useServerFn(createTask);
  const createMut = useMutation({
    mutationFn: (title: string) => createFn({ data: { title } }),
    onSuccess: () => {
      setNewTitle("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const completeFn = useServerFn(completeTask);
  const reopenFn = useServerFn(reopenTask);
  const dismissFn = useServerFn(dismissTask);
  const deleteFn = useServerFn(deleteTask);
  const confirmFn = useServerFn(confirmCompletionSuggestion);
  const dismissSuggFn = useServerFn(dismissCompletionSuggestion);

  const toggle = useMutation({
    mutationFn: (t: { id: string; status: string }) =>
      t.status === "done" ? reopenFn({ data: { id: t.id } }) : completeFn({ data: { id: t.id } }),
    onSuccess: invalidate,
  });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissFn({ data: { id } }),
    onSuccess: invalidate,
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: invalidate,
  });

  const confirmSugg = useMutation({
    mutationFn: (id: string) => confirmFn({ data: { id } }),
    onSuccess: invalidate,
  });

  const dismissSugg = useMutation({
    mutationFn: (id: string) => dismissSuggFn({ data: { id } }),
    onSuccess: invalidate,
  });

  const suggestions = useMemo(() => q.data?.suggestions ?? [], [q.data]);
  const suggByTask = useMemo(() => {
    const m = new Map<string, (typeof suggestions)[number]>();
    suggestions.forEach((s) => m.set(s.task_id, s));
    return m;
  }, [suggestions]);

  const tasks = q.data?.tasks ?? [];

  const submitNew = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    createMut.mutate(newTitle.trim());
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <header className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
            <CheckCircle2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="font-display text-2xl text-foreground">Tasks</h1>
            <p className="text-xs text-muted-foreground">
              Added manually or extracted from meetings and email.
            </p>
          </div>
        </header>

        <form onSubmit={submitNew} className="mb-6 flex gap-2">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add a task…"
            className="flex-1"
          />
          <Button type="submit" disabled={!newTitle.trim() || createMut.isPending}>
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        </form>

        <div className="mb-4 flex flex-wrap gap-2 text-xs">
          <FilterGroup
            label="Status"
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[
              ["open", "Open"],
              ["done", "Done"],
              ["dismissed", "Dismissed"],
              ["all", "All"],
            ]}
          />
          <FilterGroup
            label="Source"
            value={source}
            onChange={(v) => setSource(v as SourceFilter)}
            options={[
              ["all", "All"],
              ["manual", "Manual"],
              ["meeting", "Meeting"],
              ["email", "Email"],
            ]}
          />
        </div>

        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-sm text-destructive">Couldn't load tasks.</p>}
        {q.data && tasks.length === 0 && (
          <div className="rounded-lg border border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
            {status === "open"
              ? "No open tasks. Add one above, or Zerrow will find them from your meetings and email."
              : "Nothing here."}
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {tasks.map((t) => {
            const sugg = suggByTask.get(t.id);
            return (
              <li
                key={t.id}
                className="group rounded-lg border border-border bg-card/40 p-3 transition hover:bg-card/70"
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    onClick={() => toggle.mutate({ id: t.id, status: t.status })}
                    className="mt-0.5 text-muted-foreground hover:text-primary"
                    aria-label={t.status === "done" ? "Mark as open" : "Mark as done"}
                  >
                    {t.status === "done" ? (
                      <CheckCircle2 className="h-5 w-5 text-primary" />
                    ) : (
                      <Circle className="h-5 w-5" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div
                      className={`text-sm ${t.status === "done" ? "text-muted-foreground line-through" : "text-foreground"}`}
                    >
                      {t.title}
                    </div>
                    {t.notes && (
                      <div className="mt-0.5 text-xs text-muted-foreground">{t.notes}</div>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <SourceBadge task={t} />
                      <span>· {new Date(t.created_at).toLocaleDateString()}</span>
                    </div>

                    {sugg && t.status === "open" && (
                      <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs">
                        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                        <span className="flex-1 text-amber-900 dark:text-amber-200">
                          Looks done — {sugg.reasoning || "matched a recent sent email"}.
                        </span>
                        <button
                          className="rounded px-2 py-0.5 text-amber-900 hover:bg-amber-500/20 dark:text-amber-200"
                          onClick={() => confirmSugg.mutate(sugg.id)}
                        >
                          Mark done
                        </button>
                        <button
                          className="rounded px-2 py-0.5 text-muted-foreground hover:bg-muted"
                          onClick={() => dismissSugg.mutate(sugg.id)}
                        >
                          Not done
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    {t.status === "open" && (
                      <button
                        title="Dismiss"
                        className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-muted"
                        onClick={() => dismiss.mutate(t.id)}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      title="Delete"
                      className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => del.mutate(t.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function FilterGroup({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-card/40 p-0.5">
      <span className="px-2 text-muted-foreground">{label}:</span>
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded px-2 py-1 ${value === v ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function SourceBadge({
  task,
}: {
  task: {
    source: string;
    source_meeting_id: string | null;
    source_email_id: string | null;
    source_snippet: string | null;
  };
}) {
  if (task.source === "meeting" && task.source_meeting_id) {
    return (
      <Link
        to="/meetings"
        className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 hover:bg-muted"
      >
        <Video className="h-3 w-3" /> From meeting
      </Link>
    );
  }
  if (task.source === "email" && task.source_email_id) {
    return (
      <Link
        to="/inbox"
        className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 hover:bg-muted"
      >
        <Mail className="h-3 w-3" /> From email
      </Link>
    );
  }
  return <span className="rounded bg-muted/60 px-1.5 py-0.5">Manual</span>;
}
