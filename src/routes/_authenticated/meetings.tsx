import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listMeetings,
  getMeeting,
  recordFromLink,
  deleteMeeting,
} from "@/lib/meetings.functions";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Video, Plus, Trash2, ExternalLink, Users, FileText } from "lucide-react";

export const Route = createFileRoute("/_authenticated/meetings")({
  head: () => ({
    meta: [
      { title: "Meetings — Zerrow" },
      {
        name: "description",
        content: "Record, transcribe, and summarize your meetings automatically.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MeetingsPage,
});

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  joining: "Joining",
  recording: "Recording",
  done: "Done",
  failed: "Failed",
};

const STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-muted text-muted-foreground",
  joining: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  recording: "bg-red-500/10 text-red-600 dark:text-red-400",
  done: "bg-primary/10 text-primary",
  failed: "bg-destructive/10 text-destructive",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? "bg-muted text-muted-foreground"}`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function MeetingsPage() {
  const qc = useQueryClient();
  const list = useServerFn(listMeetings);
  const meetingsQ = useQuery({
    queryKey: ["meetings"],
    queryFn: () => list(),
    refetchInterval: 15000,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const meetings = meetingsQ.data?.meetings ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
        <header className="mb-8 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
              <Video className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-display text-2xl text-foreground">Meetings</h1>
              <p className="text-sm text-muted-foreground">
                Send a notetaker bot to record, transcribe, and summarize any call.
              </p>
            </div>
          </div>
          <RecordDialog onRecorded={() => qc.invalidateQueries({ queryKey: ["meetings"] })} />
        </header>

        {meetingsQ.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading meetings…</p>
        ) : meetings.length === 0 ? (
          <Card className="p-8 text-center">
            <Video className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No meetings yet. Paste a Zoom, Google Meet, or Teams link to record your first one, or
              turn on auto-record in Settings to capture calendar meetings automatically.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {meetings.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedId(m.id)}
                className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card p-4 text-left transition-colors hover:bg-accent/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{m.title || "Untitled meeting"}</span>
                    <StatusBadge status={m.status} />
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {m.platform ? `${m.platform.replace("_", " ")} · ` : ""}
                    {m.source === "calendar" ? "From calendar · " : ""}
                    {formatWhen(m.scheduled_start ?? m.created_at)}
                  </div>
                </div>
                {m.summary && <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <MeetingDetail id={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}

function RecordDialog({ onRecorded }: { onRecorded: () => void }) {
  const record = useServerFn(recordFromLink);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await record({ data: { meetingUrl: url.trim(), title: title.trim() || undefined } });
      toast.success("Notetaker is joining the meeting");
      setUrl("");
      setTitle("");
      setOpen(false);
      onRecorded();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not start recording");
    }
    setBusy(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1.5 h-4 w-4" /> Record a meeting
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a meeting</DialogTitle>
          <DialogDescription>
            Paste a Zoom, Google Meet, or Microsoft Teams link. A notetaker bot joins, records, and
            transcribes the call.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-url">Meeting link</Label>
            <Input
              id="meeting-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://zoom.us/j/…"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="meeting-title">Title (optional)</Label>
            <Input
              id="meeting-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Weekly sync"
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || url.trim().length === 0}>
            {busy ? "Starting…" : "Send notetaker"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TranscriptSegment = { speaker: string | null; text: string; start: number | null };

function MeetingDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getMeeting);
  const del = useServerFn(deleteMeeting);
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ["meeting", id],
    queryFn: () => getFn({ data: { id: id as string } }),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.meeting.status;
      return status && status !== "done" && status !== "failed" ? 10000 : false;
    },
  });

  const meeting = q.data?.meeting;
  const participants = q.data?.participants ?? [];
  const transcript = useMemo(
    () => (meeting?.transcript as TranscriptSegment[] | null) ?? [],
    [meeting?.transcript],
  );

  async function onDelete() {
    if (!id) return;
    setBusy(true);
    try {
      await del({ data: { id } });
      toast.success("Meeting deleted");
      qc.invalidateQueries({ queryKey: ["meetings"] });
      onClose();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not delete meeting");
    }
    setBusy(false);
  }

  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {!meeting ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {meeting.title || "Untitled meeting"}
                <StatusBadge status={meeting.status} />
              </DialogTitle>
              <DialogDescription>
                {meeting.platform ? `${meeting.platform.replace("_", " ")} · ` : ""}
                {formatWhen(meeting.scheduled_start ?? meeting.created_at)}
              </DialogDescription>
            </DialogHeader>

            {meeting.status === "failed" && meeting.error && (
              <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {meeting.error}
              </p>
            )}

            {meeting.recording_url && (
              <video
                src={meeting.recording_url}
                controls
                className="w-full rounded-md border border-border"
              />
            )}

            {participants.length > 0 && (
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <Users className="h-4 w-4" /> Participants
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {participants.map((p) => (
                    <span
                      key={p.id}
                      className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {p.name || p.email}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {meeting.summary && (
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                  <FileText className="h-4 w-4" /> Summary
                </h3>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{meeting.summary}</p>
              </section>
            )}

            {transcript.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-medium">Transcript</h3>
                <div className="space-y-2 rounded-md border border-border p-3">
                  {transcript.map((seg, i) => (
                    <p key={i} className="text-sm">
                      {seg.speaker && (
                        <span className="font-medium text-foreground">{seg.speaker}: </span>
                      )}
                      <span className="text-muted-foreground">{seg.text}</span>
                    </p>
                  ))}
                </div>
              </section>
            )}

            {meeting.status !== "done" && meeting.status !== "failed" && (
              <p className="text-sm text-muted-foreground">
                Recording in progress — the transcript and summary appear here once the meeting ends.
              </p>
            )}

            <DialogFooter className="flex items-center justify-between sm:justify-between">
              <a
                href={meeting.meeting_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open meeting link
              </a>
              <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy}>
                <Trash2 className="mr-1.5 h-4 w-4 text-destructive" />
                Delete
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
