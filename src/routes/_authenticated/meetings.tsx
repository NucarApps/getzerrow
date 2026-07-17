import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listMeetings,
  getMeeting,
  recordFromLink,
  deleteMeeting,
  renameMeeting,
  generateTitleForMeeting,
  regenerateMeetingSummary,
  syncMeeting,
  stopMeeting,
  refreshRecording,
  getRecordingStreamUrl,
  extractMeetingUrl,
  createInPersonMeeting,
  transcribeInPersonMeeting,
  listRecentUnrecordedEvents,
  resendMeetingBot,
} from "@/lib/meetings.functions";
import { encodeWav } from "@/lib/wav-encoder";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Video,
  Plus,
  Trash2,
  ExternalLink,
  Users,
  FileText,
  RefreshCw,
  Download,
  AlertCircle,
  Mic,
  Square,
  Monitor,
  ChevronDown,
  Sparkles,
  Loader2,
  Pencil,
  Settings,
} from "lucide-react";
import {
  UpcomingMeetingsCard,
  type InPersonRecordPrefill,
} from "@/components/meetings/UpcomingMeetingsCard";
import { MeetingSummary } from "@/components/meetings/meeting-summary";
import { useIsMobile } from "@/hooks/use-mobile";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useScreenWakeLock } from "@/hooks/use-screen-wake-lock";

const TERMINAL = new Set(["done", "failed"]);

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
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

const STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-muted text-muted-foreground",
  joining: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  recording: "bg-red-500/10 text-red-600 dark:text-red-400",
  processing: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
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

// Short, friendly reason a recent calendar meeting wasn't recorded.
const SKIP_REASON_LABEL: Record<string, string> = {
  no_link: "No video link",
  auto_record_off: "Auto-record off",
  declined: "Declined",
  off: "Turned off",
  in_person: "Recording in person",
  blocked: "Blocked contact",
};


function MeetingsPage() {
  const qc = useQueryClient();
  const isMobile = useIsMobile();
  const list = useServerFn(listMeetings);
  const sync = useServerFn(syncMeeting);
  const resendBot = useServerFn(resendMeetingBot);
  const listRecentUnrecorded = useServerFn(listRecentUnrecordedEvents);
  const meetingsQ = useQuery({
    queryKey: ["meetings"],
    queryFn: () => list(),
    refetchInterval: 15000,
  });
  const recentUnrecordedQ = useQuery({
    queryKey: ["recent-unrecorded-events"],
    queryFn: () => listRecentUnrecorded(),
    refetchInterval: 60000,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Set when the user taps "Record now" on an upcoming meeting — opens the
  // in-person recorder with the meeting name pre-filled and the recording
  // linked back to that calendar event.
  const [inPersonPrefill, setInPersonPrefill] = useState<InPersonRecordPrefill | null>(null);
  const meetings = meetingsQ.data?.meetings ?? [];
  const unrecorded = recentUnrecordedQ.data?.events ?? [];

  // Merge recorded meetings with recent calendar meetings that were never
  // recorded, newest first, so the past list shows everything that happened.
  const pastRows = useMemo(() => {
    type Row =
      | { kind: "meeting"; sortKey: string; meeting: (typeof meetings)[number] }
      | { kind: "unrecorded"; sortKey: string; event: (typeof unrecorded)[number] };
    const rows: Row[] = [
      ...meetings.map((m) => ({
        kind: "meeting" as const,
        sortKey: m.scheduled_start ?? m.created_at ?? "",
        meeting: m,
      })),
      ...unrecorded.map((e) => ({
        kind: "unrecorded" as const,
        sortKey: e.start ?? "",
        event: e,
      })),
    ];
    rows.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
    return rows;
  }, [meetings, unrecorded]);


  // Best-effort: pull live status for any non-terminal meetings so the list
  // badges advance without opening each one, then refresh the list once.
  const syncingRef = useRef(false);
  useEffect(() => {
    const pending = meetings.filter((m) => !TERMINAL.has(m.status));
    if (!pending.length || syncingRef.current) return;
    syncingRef.current = true;
    void (async () => {
      try {
        await Promise.all(pending.map((m) => sync({ data: { id: m.id } }).catch(() => null)));
        await qc.invalidateQueries({ queryKey: ["meetings"] });
      } finally {
        syncingRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetings.map((m) => `${m.id}:${m.status}`).join(",")]);

  const resendMutation = useMutation({
    mutationFn: (meetingId: string) => resendBot({ data: { id: meetingId } }),
    onSuccess: () => {
      toast.success("Notetaker on its way");
      qc.invalidateQueries({ queryKey: ["meetings"] });
      qc.invalidateQueries({ queryKey: ["upcoming-calendar-events"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Couldn't resend the notetaker.");
    },
  });


  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 md:py-8">
        <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between md:mb-8">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary sm:h-10 sm:w-10">
              <Video className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-xl text-foreground sm:text-2xl">Meetings</h1>
              <p className="hidden text-sm text-muted-foreground sm:block">
                Send a notetaker bot to record, transcribe, and summarize any call.
              </p>
            </div>
          </div>
          <div className="flex flex-row flex-wrap items-center gap-2">
            <InPersonRecordDialog
              onRecorded={() => {
                qc.invalidateQueries({ queryKey: ["meetings"] });
                qc.invalidateQueries({ queryKey: ["upcoming-calendar-events"] });
              }}
              prefill={inPersonPrefill}
              onPrefillClear={() => setInPersonPrefill(null)}
            />
            {!isMobile && (
              <ScreenRecordDialog
                onRecorded={() => qc.invalidateQueries({ queryKey: ["meetings"] })}
              />
            )}
            <RecordDialog onRecorded={() => qc.invalidateQueries({ queryKey: ["meetings"] })} />
            <Button
              variant="outline"
              size="icon"
              asChild
              aria-label="Meeting settings"
              title="Meeting settings"
              className="h-8 w-8 sm:h-10 sm:w-10"
            >
              <Link to="/settings/meetings-recording">
                <Settings className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </header>

        <Tabs defaultValue="upcoming">
          <TabsList className="mb-6">
            <TabsTrigger value="past">Past meetings</TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
          </TabsList>

          <TabsContent value="past">
            {meetingsQ.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading meetings…</p>
            ) : pastRows.length === 0 ? (
              <Card className="p-8 text-center">
                <Video className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No meetings yet. Paste a Zoom, Google Meet, or Teams link to record your first
                  one, or turn on auto-record in Settings to capture calendar meetings
                  automatically.
                </p>
              </Card>
            ) : (
              <div className="space-y-2">
                {pastRows.map((row) =>
                  row.kind === "meeting" ? (
                    <div
                      key={`m:${row.meeting.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedId(row.meeting.id)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setSelectedId(row.meeting.id);
                        }
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card p-4 text-left transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">
                            {row.meeting.title || "Untitled meeting"}
                          </span>
                          <StatusBadge status={row.meeting.status} />
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {row.meeting.platform ? `${row.meeting.platform.replace("_", " ")} · ` : ""}
                          {row.meeting.source === "calendar" ? "From calendar · " : ""}
                          {formatWhen(row.meeting.scheduled_start ?? row.meeting.created_at)}
                        </div>
                        {row.meeting.canResendBot && (
                          <p className="mt-1 text-xs text-destructive">
                            Notetaker didn't join — try again.
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {row.meeting.canResendBot && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              resendMutation.isPending &&
                              resendMutation.variables === row.meeting.id
                            }
                            onClick={(ev) => {
                              ev.stopPropagation();
                              resendMutation.mutate(row.meeting.id);
                            }}
                          >
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            {resendMutation.isPending &&
                            resendMutation.variables === row.meeting.id
                              ? "Sending…"
                              : "Resend notetaker"}
                          </Button>
                        )}
                        {row.meeting.summary && (
                          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                  ) : (
                    <div
                      key={`u:${row.event.accountId}:${row.event.id}`}
                      className="flex w-full items-center justify-between gap-3 rounded-md border border-dashed border-border bg-muted/20 p-4 text-left"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-muted-foreground">
                            {row.event.title || "Untitled meeting"}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Not recorded
                          </span>
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {SKIP_REASON_LABEL[row.event.skipReason ?? ""] ?? "Not recorded"} ·{" "}
                          {formatWhen(row.event.start)}
                        </div>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
          </TabsContent>


          <TabsContent value="upcoming">
            <UpcomingMeetingsCard onRecordInPerson={setInPersonPrefill} />
          </TabsContent>
        </Tabs>
      </div>

      <MeetingDetail id={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}

const PLATFORM_LABEL: Record<string, string> = {
  zoom: "Zoom",
  google_meet: "Google Meet",
  teams: "Microsoft Teams",
  webex: "Webex",
};

function platformOf(url: string): string | null {
  if (/zoom\.us/i.test(url)) return "zoom";
  if (/meet\.google\.com/i.test(url)) return "google_meet";
  if (/teams\.(microsoft|live)\.com/i.test(url)) return "teams";
  if (/webex\.com/i.test(url)) return "webex";
  return null;
}

function RecordDialog({ onRecorded }: { onRecorded: () => void }) {
  const record = useServerFn(recordFromLink);
  const [open, setOpen] = useState(false);
  const [rawInput, setRawInput] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const detectedUrl = useMemo(() => extractMeetingUrl(rawInput), [rawInput]);
  const detectedPlatform = detectedUrl ? platformOf(detectedUrl) : null;
  const showInvalidHint = rawInput.trim().length > 0 && !detectedUrl;

  async function submit() {
    if (!detectedUrl) return;
    setBusy(true);
    try {
      await record({ data: { meetingUrl: detectedUrl, title: title.trim() || undefined } });
      toast.success("Notetaker is joining the meeting");
      setRawInput("");
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
        <Button size="sm" className="sm:h-10 sm:px-4">
          <Plus className="mr-1.5 h-4 w-4" /> Record
          <span className="hidden min-[380px]:inline">&nbsp;a meeting</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>Record a meeting</DialogTitle>
          <DialogDescription>
            Paste a Zoom, Google Meet, or Microsoft Teams link — or the whole invite. A notetaker
            bot joins, records, and transcribes the call.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="meeting-url">Meeting link</Label>
            <Input
              id="meeting-url"
              value={rawInput}
              onChange={(e) => setRawInput(e.target.value)}
              placeholder="https://zoom.us/j/… or paste the invite"
              autoComplete="off"
            />
            {detectedPlatform && (
              <p className="text-xs text-primary">
                Detected {PLATFORM_LABEL[detectedPlatform] ?? "meeting"} link ✓
              </p>
            )}
            {showInvalidHint && (
              <p className="text-xs text-muted-foreground">
                No supported link found yet. Paste a Zoom, Google Meet, or Microsoft Teams link.
              </p>
            )}
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
          <Button onClick={submit} disabled={busy || !detectedUrl}>
            {busy ? "Starting…" : "Send notetaker"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function InPersonRecordDialog({
  onRecorded,
  prefill,
  onPrefillClear,
}: {
  onRecorded: () => void;
  prefill?: InPersonRecordPrefill | null;
  onPrefillClear?: () => void;
}) {
  const createMeeting = useServerFn(createInPersonMeeting);
  const transcribe = useServerFn(transcribeInPersonMeeting);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<"idle" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [iframeBlocked, setIframeBlocked] = useState(false);


  // A "Record now" tap on an upcoming meeting opens the recorder with the
  // meeting's name pre-filled; the recording stays linked to that event.
  useEffect(() => {
    if (prefill) {
      setTitle(prefill.title);
      setError(null);
      setBlocked(false);
      setOpen(true);
    }
  }, [prefill]);

  // Capture raw PCM via Web Audio and encode a WAV on stop. This avoids iOS
  // Safari's fragmented MP4 (which fails to play back and makes the STT model
  // hallucinate/loop) by uploading a standard, decodable WAV file.
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmRef = useRef<Float32Array[]>([]);
  const sampleRateRef = useRef<number>(16000);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keep the screen awake while recording so mobile browsers don't suspend the
  // tab (and stop capture) when the device would otherwise sleep. Falls back to
  // a hidden looping video where the Wake Lock API is unavailable.
  const { acquire: acquireWakeLock, release: releaseWakeLock } = useScreenWakeLock();

  function cleanupStream() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    releaseWakeLock();
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      void audioCtxRef.current.close().catch(() => {});
    }
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function resetState() {
    cleanupStream();
    pcmRef.current = [];
    setPhase("idle");
    setElapsed(0);
    setError(null);
    setBlocked(false);
  }

  const BLOCKED_MESSAGE =
    "Microphone is blocked for this site. Click the padlock (or camera/mic icon) in your browser's address bar, set Microphone to Allow, then reload and try again.";
  const IFRAME_BLOCKED_MESSAGE =
    "Recording can't run inside the preview frame. Open the app in a new tab to grant microphone access, then start recording there.";

  function detectIframeBlock(): boolean {
    try {
      if (typeof window === "undefined") return false;
      const inIframe = window.self !== window.top;
      if (!inIframe) return false;
      const fp = (document as unknown as { featurePolicy?: { allowsFeature?: (f: string) => boolean } })
        .featurePolicy;
      if (fp?.allowsFeature && !fp.allowsFeature("microphone")) return true;
      // If we're in an iframe and permissions-policy status is unknown, assume blocked.
      return true;
    } catch {
      return false;
    }
  }


  async function startRecording() {
    setError(null);
    setBlocked(false);

    const AudioCtx: typeof AudioContext | undefined =
      typeof window !== "undefined"
        ? (window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
        : undefined;

    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !AudioCtx) {
      setError("Recording needs a secure (https) connection in a supported browser.");
      return;
    }

    // Proactively read the permission state so a persisted block is explained
    // without waiting for a silent getUserMedia rejection. Safari lacks this API.
    try {
      const status = await navigator.permissions?.query({
        name: "microphone" as PermissionName,
      });
      if (status?.state === "denied") {
        setBlocked(true);
        setError(BLOCKED_MESSAGE);
        return;
      }
    } catch {
      // Permission query unsupported — fall through to getUserMedia.
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      pcmRef.current = [];

      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      sampleRateRef.current = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (e) => {
        pcmRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(ctx.destination);

      setPhase("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((v) => v + 1), 1000);
      // The hook re-acquires on visibility changes internally.
      void acquireWakeLock();
    } catch (err: unknown) {
      cleanupStream();
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setBlocked(true);
        setError(BLOCKED_MESSAGE);
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No microphone was found. Connect a mic and try again.");
      } else if (name === "NotReadableError" || name === "AbortError") {
        setError("Your microphone is in use by another app. Close it and try again.");
      } else {
        setError("Couldn't start recording. Please try again.");
      }
    }
  }

  function stopRecording() {
    if (phase !== "recording") return;
    void finishRecording();
  }

  async function finishRecording() {
    const sampleRate = sampleRateRef.current;
    const chunks = pcmRef.current;
    pcmRef.current = [];
    cleanupStream();

    const blob = encodeWav(chunks, sampleRate);
    // A silent mic or an instant start/stop yields a header-only WAV.
    if (blob.size < 2048) {
      setError("That recording was empty — please try again.");
      setPhase("idle");
      return;
    }
    setPhase("processing");
    try {
      const { id, audioPath } = await createMeeting({
        data: {
          title: title.trim() || undefined,
          ext: "wav",
          calendarEventId: prefill?.calendarEventId,
          accountId: prefill?.accountId,
          scheduledStart: prefill?.scheduledStart ?? undefined,
        },
      });
      const { error: upErr } = await supabase.storage
        .from("meeting-recordings")
        .upload(audioPath, blob, { contentType: "audio/wav", upsert: true });
      if (upErr) throw new Error(upErr.message);
      await transcribe({ data: { id, audioPath } });
      toast.success("Recording saved — transcribing now");
      onRecorded();
      setTitle("");
      setOpen(false);
      resetState();
      onPrefillClear?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save the recording.");
      setPhase("idle");
    }
  }

  function onOpenChange(next: boolean) {
    if (!next && (phase === "recording" || phase === "processing")) return;
    if (!next) {
      resetState();
      setTitle("");
      onPrefillClear?.();
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="sm:h-10 sm:px-4"
          aria-label="Record in person"
        >
          <Mic className="h-4 w-4 min-[380px]:mr-1.5" />
          <span className="hidden min-[380px]:inline sm:hidden">In person</span>
          <span className="hidden sm:inline">Record in person</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>Record an in-person meeting</DialogTitle>
          <DialogDescription>
            Capture the conversation with your device microphone. When you stop, we upload the audio
            and transcribe and summarize it automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="in-person-title">Title (optional)</Label>
            <Input
              id="in-person-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Coffee with Alex"
              autoComplete="off"
              disabled={phase !== "idle"}
            />
          </div>

          <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/30 p-4 sm:p-6">
            {phase === "recording" ? (
              <>
                <span className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
                  Recording
                </span>
                <span className="font-mono text-2xl tabular-nums text-foreground">
                  {formatElapsed(elapsed)}
                </span>
                <Button variant="destructive" onClick={stopRecording}>
                  <Square className="mr-1.5 h-4 w-4" /> Stop &amp; save
                </Button>
              </>
            ) : phase === "processing" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" /> Uploading and transcribing…
              </p>
            ) : (
              <>
                <Mic className="h-8 w-8 text-muted-foreground" />
                <Button onClick={startRecording}>
                  <Mic className="mr-1.5 h-4 w-4" /> Start recording
                </Button>
              </>
            )}
          </div>

          {error && (
            <div className="space-y-2">
              <p className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </p>
              {blocked && (
                <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                  <RefreshCw className="mr-1.5 h-4 w-4" /> Reload page
                </Button>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function pickMime(candidates: string[], fallback: string): string {
  if (typeof MediaRecorder === "undefined") return fallback;
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return fallback;
}

/**
 * Desktop-only screen recorder: captures the screen video plus mixed
 * system/tab audio and the microphone. Two recorders run at once — one writes a
 * playable video, the other a clean audio track used for transcription.
 */
function ScreenRecordDialog({ onRecorded }: { onRecorded: () => void }) {
  const createMeeting = useServerFn(createInPersonMeeting);
  const transcribe = useServerFn(transcribeInPersonMeeting);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [phase, setPhase] = useState<"idle" | "recording" | "processing">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const displayStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const videoRecorderRef = useRef<MediaRecorder | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<Blob[]>([]);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keeps the screen awake during capture, falling back to a hidden looping
  // video where the Wake Lock API is unavailable.
  const { acquire: acquireWakeLock, release: releaseWakeLock } = useScreenWakeLock();

  function cleanup() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    releaseWakeLock();
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
    micStreamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    videoRecorderRef.current = null;
    audioRecorderRef.current = null;
  }

  function resetState() {
    cleanup();
    videoChunksRef.current = [];
    audioChunksRef.current = [];
    setPhase("idle");
    setElapsed(0);
    setError(null);
  }

  async function startRecording() {
    setError(null);

    if (!window.isSecureContext || !navigator.mediaDevices?.getDisplayMedia) {
      setError("Screen recording isn't supported in this browser.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("Recording isn't supported in this browser.");
      return;
    }

    let displayStream: MediaStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch {
      // User cancelled the picker or denied screen access.
      setError("Screen sharing was cancelled. Choose a screen, window, or tab to record.");
      return;
    }
    displayStreamRef.current = displayStream;

    // Best-effort microphone capture; a denied mic still records system audio.
    let micStream: MediaStream | null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;
    } catch {
      micStream = null;
    }

    const videoTrack = displayStream.getVideoTracks()[0];
    if (!videoTrack) {
      cleanup();
      setError("No screen video was captured. Try again.");
      return;
    }

    try {
      // Mix system audio + mic into two independent destination tracks so the
      // video and audio recorders each get their own stream.
      const AudioCtx: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const videoDest = ctx.createMediaStreamDestination();
      const audioDest = ctx.createMediaStreamDestination();

      const connect = (stream: MediaStream) => {
        if (stream.getAudioTracks().length === 0) return;
        const src = ctx.createMediaStreamSource(stream);
        src.connect(videoDest);
        src.connect(audioDest);
      };
      connect(displayStream);
      if (micStream) connect(micStream);

      const videoStream = new MediaStream([videoTrack, ...videoDest.stream.getAudioTracks()]);
      const audioStream = new MediaStream(audioDest.stream.getAudioTracks());

      const videoMime = pickMime(
        ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
        "video/webm",
      );
      const audioMime = pickMime(["audio/webm;codecs=opus", "audio/webm"], "audio/webm");

      videoChunksRef.current = [];
      audioChunksRef.current = [];
      const videoRecorder = new MediaRecorder(videoStream, { mimeType: videoMime });
      const audioRecorder = new MediaRecorder(audioStream, { mimeType: audioMime });
      videoRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) videoChunksRef.current.push(e.data);
      };
      audioRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      let stopped = 0;
      const onOneStopped = () => {
        stopped += 1;
        if (stopped >= 2) void finishRecording();
      };
      videoRecorder.onstop = onOneStopped;
      audioRecorder.onstop = onOneStopped;

      videoRecorderRef.current = videoRecorder;
      audioRecorderRef.current = audioRecorder;

      // The browser's own "Stop sharing" control ends the screen track.
      videoTrack.addEventListener("ended", () => stopRecording());

      videoRecorder.start();
      audioRecorder.start();
      setPhase("recording");
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((v) => v + 1), 1000);
      void acquireWakeLock();
    } catch {
      cleanup();
      setError("Couldn't start screen recording. Please try again.");
    }
  }

  function stopRecording() {
    const v = videoRecorderRef.current;
    const a = audioRecorderRef.current;
    if (v && v.state !== "inactive") v.stop();
    if (a && a.state !== "inactive") a.stop();
    // Stop capturing so the browser's sharing indicator clears immediately.
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
  }

  async function finishRecording() {
    const videoMime = videoRecorderRef.current?.mimeType || "video/webm";
    const audioMime = audioRecorderRef.current?.mimeType || "audio/webm";
    const videoBlob = new Blob(videoChunksRef.current, { type: videoMime });
    const audioBlob = new Blob(audioChunksRef.current, { type: audioMime });
    videoChunksRef.current = [];
    audioChunksRef.current = [];
    // Keep the audio context/streams around no longer than needed.
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    releaseWakeLock();
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;

    if (videoBlob.size === 0 || audioBlob.size === 0) {
      setError("Nothing was recorded. Try again.");
      setPhase("idle");
      return;
    }
    setPhase("processing");
    try {
      const { id, audioPath, videoPath } = await createMeeting({
        data: { title: title.trim() || undefined, ext: "webm", withVideo: true, videoExt: "webm" },
      });
      if (!videoPath) throw new Error("Missing video path");
      const [audioUp, videoUp] = await Promise.all([
        supabase.storage
          .from("meeting-recordings")
          .upload(audioPath, audioBlob, { contentType: audioMime, upsert: true }),
        supabase.storage
          .from("meeting-recordings")
          .upload(videoPath, videoBlob, { contentType: videoMime, upsert: true }),
      ]);
      if (audioUp.error) throw new Error(audioUp.error.message);
      if (videoUp.error) throw new Error(videoUp.error.message);
      await transcribe({ data: { id, audioPath, videoPath } });
      toast.success("Recording saved — transcribing now");
      onRecorded();
      setTitle("");
      setOpen(false);
      resetState();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save the recording.");
      setPhase("idle");
    }
  }

  function onOpenChange(next: boolean) {
    if (!next && (phase === "recording" || phase === "processing")) return;
    if (!next) resetState();
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full sm:w-auto">
          <Monitor className="mr-1.5 h-4 w-4" /> Record screen
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] w-[calc(100%-2rem)] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        <DialogHeader>
          <DialogTitle>Record your screen</DialogTitle>
          <DialogDescription>
            Capture your screen with system audio and your microphone. When you stop, we upload the
            video and transcribe and summarize it automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="screen-title">Title (optional)</Label>
            <Input
              id="screen-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Product demo"
              autoComplete="off"
              disabled={phase !== "idle"}
            />
          </div>

          <div className="flex flex-col items-center gap-3 rounded-md border border-border bg-muted/30 p-4 sm:p-6">
            {phase === "recording" ? (
              <>
                <span className="flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
                  Recording
                </span>
                <span className="font-mono text-2xl tabular-nums text-foreground">
                  {formatElapsed(elapsed)}
                </span>
                <Button variant="destructive" onClick={stopRecording}>
                  <Square className="mr-1.5 h-4 w-4" /> Stop &amp; save
                </Button>
              </>
            ) : phase === "processing" ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" /> Uploading and transcribing…
              </p>
            ) : (
              <>
                <Monitor className="h-8 w-8 text-muted-foreground" />
                <Button onClick={startRecording}>
                  <Monitor className="mr-1.5 h-4 w-4" /> Start recording
                </Button>
              </>
            )}
          </div>

          {error && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type TranscriptSegment = { speaker: string | null; text: string; start: number | null };
type RecordingDiagnostics = {
  hasRecording: boolean;
  hasTranscript: boolean;
  hasSummary: boolean;
};

function MeetingDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getMeeting);
  const del = useServerFn(deleteMeeting);
  const sync = useServerFn(syncMeeting);
  const stop = useServerFn(stopMeeting);
  const refreshRec = useServerFn(refreshRecording);
  const getStream = useServerFn(getRecordingStreamUrl);
  const rename = useServerFn(renameMeeting);
  const genTitle = useServerFn(generateTitleForMeeting);
  const regenSummary = useServerFn(regenerateMeetingSummary);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmStopOpen, setConfirmStopOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [regeneratingSummary, setRegeneratingSummary] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [videoError, setVideoError] = useState(false);
  const [diagnostics, setDiagnostics] = useState<RecordingDiagnostics | null>(null);
  // A same-origin, tokenized stream URL. The player can't send an auth header,
  // and Recall's raw S3 URL is short-lived and served as octet-stream (which
  // mobile browsers won't play), so we proxy it through our own route.
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [streamKind, setStreamKind] = useState<"video" | "audio">("video");
  const isMobile = useIsMobile();
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const cancelTitleRef = useRef(false);

  const q = useQuery({
    queryKey: ["meeting", id],
    queryFn: () => getFn({ data: { id: id as string } }),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.meeting.status;
      return status && !TERMINAL.has(status) ? 10000 : false;
    },
  });

  const meeting = q.data?.meeting;
  const participants = q.data?.participants ?? [];
  const transcript = useMemo(
    () => (meeting?.transcript as TranscriptSegment[] | null) ?? [],
    [meeting?.transcript],
  );
  const hasRecording = !!(diagnostics?.hasRecording || meeting?.recording_url);

  // Pull the live status from Recall whenever a non-terminal meeting is open,
  // and again on each poll tick, so the badge advances even without webhooks.
  const status = meeting?.status;
  useEffect(() => {
    if (!id || !status || TERMINAL.has(status)) return;
    void sync({ data: { id } })
      .then((r) => {
        if (r.status !== status) qc.invalidateQueries({ queryKey: ["meeting", id] });
      })
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, status, q.dataUpdatedAt]);

  // When a finished meeting opens, backfill transcript/summary if they never
  // landed, then mint a same-origin stream URL for the player.
  useEffect(() => {
    setStreamUrl(null);
    setStreamKind("video");
    setRecordingError(null);
    setVideoError(false);
    setDiagnostics(null);
    if (!id || !status || !TERMINAL.has(status)) return;
    let cancelled = false;
    void refreshRec({ data: { id } })
      .then(async (r) => {
        if (cancelled) return;
        setDiagnostics({
          hasRecording: r.hasRecording,
          hasTranscript: r.hasTranscript,
          hasSummary: r.hasSummary,
        });
        // Transcript/summary may have been backfilled — pull the latest row.
        qc.invalidateQueries({ queryKey: ["meeting", id] });
        if (r.hasRecording) {
          const s = await getStream({ data: { id } });
          if (!cancelled && s.streamUrl) {
            setStreamUrl(s.streamUrl);
            setStreamKind(s.kind ?? "video");
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecordingError("Could not load the recording yet. Try again in a moment.");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, status]);

  async function onRefresh() {
    if (!id) return;
    setRefreshing(true);
    try {
      await sync({ data: { id } });
      await qc.invalidateQueries({ queryKey: ["meeting", id] });
      await qc.invalidateQueries({ queryKey: ["meetings"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not refresh status");
    }
    setRefreshing(false);
  }

  async function onRefreshRecording() {
    if (!id) return;
    setRefreshing(true);
    setRecordingError(null);
    try {
      const r = await refreshRec({ data: { id } });
      setDiagnostics({
        hasRecording: r.hasRecording,
        hasTranscript: r.hasTranscript,
        hasSummary: r.hasSummary,
      });
      await qc.invalidateQueries({ queryKey: ["meeting", id] });
      if (r.hasRecording) {
        const s = await getStream({ data: { id } });
        if (s.streamUrl) {
          setStreamUrl(s.streamUrl);
          setStreamKind(s.kind ?? "video");
        }
        setVideoError(false);
      } else {
        setRecordingError("The meeting is done, but no recording file is available yet.");
      }
    } catch (e: unknown) {
      setRecordingError(e instanceof Error ? e.message : "Could not refresh recording");
    }
    setRefreshing(false);
  }

  async function onRegenerateSummary() {
    if (!id) return;
    setRegeneratingSummary(true);
    try {
      await regenSummary({ data: { id } });
      await qc.invalidateQueries({ queryKey: ["meeting", id] });
      await qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.success("Summary updated");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not regenerate summary");
    }
    setRegeneratingSummary(false);
  }


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

  async function onStop() {
    if (!id) return;
    setStopping(true);
    try {
      await stop({ data: { id } });
      toast.success("Recording stopped — finalizing…");
      qc.invalidateQueries({ queryKey: ["meeting", id] });
      qc.invalidateQueries({ queryKey: ["meetings"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not stop the recording");
    } finally {
      setStopping(false);
      setConfirmStopOpen(false);
    }
  }


  function startEditTitle() {
    if (!meeting) return;
    setTitleDraft(meeting.title ?? "");
    setEditingTitle(true);
  }

  function cancelEditTitle() {
    cancelTitleRef.current = true;
    setEditingTitle(false);
  }

  async function saveTitle() {
    if (cancelTitleRef.current) {
      cancelTitleRef.current = false;
      return;
    }
    if (!id) return;
    const next = titleDraft.trim();
    if (next === (meeting?.title ?? "")) {
      setEditingTitle(false);
      return;
    }
    setSavingTitle(true);
    try {
      await rename({ data: { id, title: next } });
      await qc.invalidateQueries({ queryKey: ["meeting", id] });
      qc.invalidateQueries({ queryKey: ["meetings"] });
      setEditingTitle(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not rename meeting");
    }
    setSavingTitle(false);
  }

  async function onGenerateTitle() {
    if (!id) return;
    setGeneratingTitle(true);
    try {
      const r = await genTitle({ data: { id } });
      await qc.invalidateQueries({ queryKey: ["meeting", id] });
      qc.invalidateQueries({ queryKey: ["meetings"] });
      toast.success(`Title set to "${r.title}"`);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not generate a title");
    }
    setGeneratingTitle(false);
  }

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        {!meeting ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <SheetHeader className="space-y-1 border-b border-border p-4 pb-3 text-left sm:p-6 sm:pb-4">
              <SheetTitle className="flex items-center gap-2 pr-6 text-base sm:text-lg">
                {editingTitle ? (
                  <Input
                    autoFocus
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={saveTitle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveTitle();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        cancelEditTitle();
                      }
                    }}
                    disabled={savingTitle}
                    placeholder="Meeting title"
                    className="h-8 flex-1"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={startEditTitle}
                    className="group flex min-w-0 items-center gap-1.5 rounded-md text-left hover:text-foreground/80"
                    title="Click to rename"
                  >
                    <span className="truncate">{meeting.title || "Untitled meeting"}</span>
                    <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={onGenerateTitle}
                  disabled={
                    generatingTitle || savingTitle || !(meeting.summary || transcript.length)
                  }
                  title={
                    meeting.summary || transcript.length
                      ? "Generate title from the meeting"
                      : "Add a recording first to generate a title"
                  }
                >
                  {generatingTitle ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  <span className="sr-only">Generate title</span>
                </Button>
                <StatusBadge status={meeting.status} />
              </SheetTitle>

              <SheetDescription>
                {meeting.platform ? `${meeting.platform.replace("_", " ")} · ` : ""}
                {formatWhen(meeting.scheduled_start ?? meeting.created_at)}
              </SheetDescription>
            </SheetHeader>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="space-y-4 p-4 pb-3 sm:p-6 sm:pb-4">
                {meeting.status === "failed" && meeting.error && (
                  <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                    {meeting.error}
                  </p>
                )}

                {streamUrl && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {streamKind === "audio" ? "Recording (audio)" : "Recording"}
                    </p>
                    {streamKind === "audio" ? (
                      <audio
                        key={streamUrl}
                        controls
                        preload="metadata"
                        onError={() => setVideoError(true)}
                        className="w-full rounded-md border border-border bg-muted/30"
                        src={streamUrl}
                      />
                    ) : (
                      <video
                        key={streamUrl}
                        controls
                        playsInline
                        preload="metadata"
                        onError={() => setVideoError(true)}
                        className="w-full rounded-md border border-border bg-black"
                      >
                        <source src={streamUrl} type="video/mp4" />
                      </video>
                    )}
                    <Collapsible
                      open={isMobile ? extrasOpen : true}
                      onOpenChange={setExtrasOpen}
                      className="space-y-2"
                    >
                      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-xs font-medium text-muted-foreground md:hidden">
                        <span>Open / download recording</span>
                        <ChevronDown
                          className={`h-4 w-4 transition-transform ${extrasOpen ? "rotate-180" : ""}`}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-2">
                        {videoError && (
                          <p className="text-xs text-muted-foreground">
                            Trouble playing here? Open or download the recording below.
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-4">
                          <a
                            href={streamUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                          >
                            <ExternalLink className="h-3.5 w-3.5" /> Open recording
                          </a>
                          <a
                            href={`${streamUrl}&dl=1`}
                            download
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <Download className="h-3.5 w-3.5" /> Download
                          </a>
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </div>
                )}

                {meeting.status === "done" && (
                  <div className="text-sm sm:rounded-md sm:border sm:border-border sm:bg-muted/30 sm:p-3">
                    <div className="flex flex-wrap items-center justify-between gap-3 max-sm:justify-start">
                      <div className="space-y-1 max-sm:hidden">
                        <p className="font-medium text-foreground">Recording status</p>
                        <p className="text-muted-foreground">
                          Recording {hasRecording ? "found" : "not found yet"} · Transcript{" "}
                          {diagnostics?.hasTranscript || transcript.length > 0
                            ? "found"
                            : "not found yet"}{" "}
                          · Summary{" "}
                          {diagnostics?.hasSummary || !!meeting.summary ? "found" : "not found yet"}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onRefreshRecording}
                        disabled={refreshing}
                        aria-label={refreshing ? "Refreshing recording" : "Refresh recording"}
                        className="shrink-0 max-sm:h-9 max-sm:w-9 max-sm:p-0"
                      >
                        <RefreshCw
                          className={`h-4 w-4 sm:mr-1.5 ${refreshing ? "animate-spin" : ""}`}
                        />
                        <span className="max-sm:hidden">
                          {refreshing ? "Refreshing…" : "Refresh recording"}
                        </span>
                      </Button>
                    </div>
                    {recordingError && (
                      <p className="mt-3 flex items-start gap-2 text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{recordingError}</span>
                      </p>
                    )}
                  </div>
                )}
              </div>

              <Tabs defaultValue="summary" className="flex flex-col">
                <TabsList className="sticky top-0 z-10 mx-4 w-[calc(100%-2rem)] bg-background sm:mx-6 sm:w-[calc(100%-3rem)]">
                  <TabsTrigger value="summary" className="flex-1">
                    Summary
                  </TabsTrigger>
                  <TabsTrigger value="transcript" className="flex-1">
                    Transcript
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="summary" className="mt-0 space-y-5 p-4 pt-4 sm:p-6">
                  {!TERMINAL.has(meeting.status) ? (
                    <div className="flex flex-col gap-3 rounded-md bg-muted/50 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-muted-foreground">
                        Recording in progress — the transcript and summary appear here once the
                        meeting ends.
                      </p>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={onRefresh}
                          disabled={refreshing}
                        >
                          <RefreshCw
                            className={`mr-1.5 h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                          />
                          {refreshing ? "Refreshing…" : "Refresh status"}
                        </Button>
                        {meeting.recall_bot_id && (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setConfirmStopOpen(true)}
                            disabled={stopping}
                          >
                            <Square className={`mr-1.5 h-4 w-4 ${stopping ? "animate-pulse" : ""}`} />
                            {stopping ? "Stopping…" : "Stop recording"}
                          </Button>
                        )}
                      </div>
                      <AlertDialog open={confirmStopOpen} onOpenChange={setConfirmStopOpen}>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Stop this recording?</AlertDialogTitle>
                            <AlertDialogDescription>
                              The notetaker bot will leave the meeting and we'll finalize the
                              recording, transcript, and summary. This can't be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel disabled={stopping}>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={(e) => {
                                e.preventDefault();
                                void onStop();
                              }}
                              disabled={stopping}
                            >
                              {stopping ? "Stopping…" : "Stop recording"}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  ) : (
                    <>
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

                      <section>
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <h3 className="flex items-center gap-1.5 text-sm font-medium">
                            <FileText className="h-4 w-4" /> Summary
                          </h3>
                          {transcript.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={onRegenerateSummary}
                              disabled={regeneratingSummary}
                              className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                            >
                              {regeneratingSummary ? (
                                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                              )}
                              {regeneratingSummary ? "Regenerating…" : "Regenerate summary"}
                            </Button>
                          )}
                        </div>
                        {meeting.summary ? (
                          <MeetingSummary markdown={meeting.summary} />
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No summary yet. It appears here once the recording is processed.
                          </p>
                        )}
                      </section>
                    </>
                  )}
                </TabsContent>

                <TabsContent value="transcript" className="mt-0 p-4 pt-4 sm:p-6">
                  {transcript.length > 0 ? (
                    <div className="space-y-3 rounded-md border border-border p-3 sm:p-4">
                      {transcript.map((seg, i) => (
                        <p key={i} className="text-sm leading-relaxed">
                          {seg.speaker && (
                            <span className="font-medium text-foreground">{seg.speaker}: </span>
                          )}
                          <span className="text-muted-foreground">{seg.text}</span>
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No transcript yet. It appears here once the recording is processed.
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border p-4 py-3 sm:p-6 sm:py-4">
              {meeting.meeting_url ? (
                <a
                  href={meeting.meeting_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open meeting link
                </a>
              ) : (
                <span className="text-sm text-muted-foreground">In-person recording</span>
              )}
              <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy}>
                <Trash2 className="mr-1.5 h-4 w-4 text-destructive" />
                Delete
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
