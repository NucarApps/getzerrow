import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CalendarClock, Mic, RefreshCw, Video } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { startConnectGmail } from "@/lib/gmail.functions";
import {
  listAllUpcomingCalendarEvents,
  resendMeetingBot,
  setEventRecordingMode,
} from "@/lib/meetings.functions";

/** How one upcoming meeting should be captured. */
type RecordMode = "bot" | "in_person" | "off";

/** Everything the in-person recorder needs to capture a calendar meeting. */
export type InPersonRecordPrefill = {
  title: string;
  calendarEventId: string;
  accountId: string;
  scheduledStart: string | null;
};

const MODE_LABEL: Record<RecordMode, string> = {
  bot: "Send notetaker",
  in_person: "Record in person",
  off: "Don't record",
};

function formatWhen(iso: string | null): string {
  if (!iso) return "No start time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function UpcomingMeetingsCard({
  onRecordInPerson,
}: {
  onRecordInPerson: (prefill: InPersonRecordPrefill) => void;
}) {
  const qc = useQueryClient();
  const listEvents = useServerFn(listAllUpcomingCalendarEvents);
  const setMode = useServerFn(setEventRecordingMode);
  const startConnect = useServerFn(startConnectGmail);
  const resendBot = useServerFn(resendMeetingBot);
  const [reconnectBusy, setReconnectBusy] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["upcoming-calendar-events"],
    queryFn: () => listEvents(),
  });

  async function handleReconnect(accountId: string, email: string | null) {
    setReconnectBusy(accountId);
    try {
      const r = await startConnect({ data: email ? { login_hint: email } : {} });
      window.location.href = r.url;
    } catch (e) {
      toast.error((e as Error).message);
      setReconnectBusy(null);
    }
  }

  const mutation = useMutation({
    mutationFn: (vars: { accountId: string; calendarEventId: string; mode: RecordMode }) =>
      setMode({ data: vars }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["upcoming-calendar-events"] });
      const prev = qc.getQueryData(["upcoming-calendar-events"]);
      qc.setQueryData(["upcoming-calendar-events"], (old: typeof data) =>
        old
          ? {
              ...old,
              events: old.events.map((e) =>
                e.id === vars.calendarEventId && e.accountId === vars.accountId
                  ? { ...e, recordMode: vars.mode, excluded: vars.mode !== "bot" }
                  : e,
              ),
            }
          : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["upcoming-calendar-events"], ctx.prev);
      toast.error("Couldn't update that event.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["upcoming-calendar-events"] });
    },
  });

  const resendMutation = useMutation({
    mutationFn: (meetingId: string) => resendBot({ data: { id: meetingId } }),
    onSuccess: () => {
      toast.success("Notetaker on its way");
      qc.invalidateQueries({ queryKey: ["upcoming-calendar-events"] });
      qc.invalidateQueries({ queryKey: ["meetings"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Couldn't resend the notetaker.");
    },
  });

  const noCalendar = !!data && !data.calendarAccess;
  const events = data?.events ?? [];
  const needsReconnect = data?.accountsNeedingReconnect ?? [];
  // Show every calendar meeting, even ones without a supported video link —
  // those just can't be joined by the notetaker (shown with a muted note).
  const recordable = events;
  const multipleAccounts = new Set(recordable.map((e) => e.accountId)).size > 1;

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 md:p-6">
        <CalendarClock className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-display text-lg sm:text-2xl">Upcoming meetings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            For each meeting, choose to send the notetaker, record in person yourself, or keep it
            private and not record at all.
          </p>
        </div>
      </div>

      <div className="p-4 md:p-6">
        {needsReconnect.length > 0 && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-3 text-xs">
            <div className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {needsReconnect.length === 1
                    ? "An inbox needs reconnecting"
                    : "Some inboxes need reconnecting"}
                </div>
                <div className="mt-0.5 text-destructive/80">
                  We can't read the calendar for{" "}
                  {needsReconnect.map((a) => a.email ?? "an inbox").join(", ")}, so its meetings
                  aren't shown here. Reconnect to see them.
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {needsReconnect.map((a) => (
                    <Button
                      key={a.id}
                      size="sm"
                      variant="destructive"
                      onClick={() => handleReconnect(a.id, a.email)}
                      disabled={reconnectBusy === a.id}
                    >
                      <RefreshCw className="mr-1.5 h-3 w-3" />
                      {reconnectBusy === a.id ? "Redirecting…" : `Reconnect ${a.email ?? "inbox"}`}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
        {noCalendar ? (
          <p className="text-sm text-muted-foreground">
            Calendar access hasn't been granted yet. Connect Google with calendar access in Settings
            to see your upcoming meetings.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your upcoming meetings…</p>
        ) : recordable.length === 0 ? (
          needsReconnect.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No meetings on your calendar in the next 14 days.
            </p>
          ) : null
        ) : (
          <ul className="divide-y divide-border">
            {recordable.map((e) => {
              const mode = (e.recordMode ?? (e.excluded ? "off" : "bot")) as RecordMode;
              return (
                <li
                  key={`${e.accountId}:${e.id}`}
                  className="flex items-start justify-between gap-3 py-3 first:pt-0 sm:gap-4"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                      <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {e.title || "Untitled meeting"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatWhen(e.start)}
                      {multipleAccounts && e.accountEmail && ` · ${e.accountEmail}`}
                      {mode === "bot" && e.scheduled && !e.blocked && " · Notetaker scheduled"}
                    </p>
                    {e.blocked && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Guest on your don't-record list — won't be recorded.
                      </p>
                    )}
                    {!e.blocked && mode === "in_person" && (
                      <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-primary">
                        <Mic className="h-3 w-3 shrink-0" />
                        You'll record this one in person
                      </p>
                    )}
                    {e.canResendBot && (
                      <p className="mt-0.5 text-xs text-destructive">
                        Notetaker didn't join — try again.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {!e.hasMeetingLink ? (
                      <span className="max-w-[168px] text-right text-xs text-muted-foreground">
                        No video link — the notetaker can't join
                      </span>
                    ) : e.blocked ? (
                      <span className="text-xs text-muted-foreground">Blocked</span>
                    ) : (
                      <>
                        <Select
                          value={mode}
                          disabled={mutation.isPending}
                          onValueChange={(next) => {
                            if (next === mode) return;
                            mutation.mutate({
                              accountId: e.accountId,
                              calendarEventId: e.id,
                              mode: next as RecordMode,
                            });
                          }}
                        >
                          <SelectTrigger
                            className="h-8 w-[168px] text-xs"
                            aria-label={`How to capture ${e.title || "this meeting"}`}
                          >
                            <SelectValue>{MODE_LABEL[mode]}</SelectValue>
                          </SelectTrigger>
                          <SelectContent align="end">
                            <SelectItem value="bot">Send notetaker</SelectItem>
                            <SelectItem value="in_person">Record in person</SelectItem>
                            <SelectItem value="off">Don't record</SelectItem>
                          </SelectContent>
                        </Select>
                        {mode === "in_person" && (
                          <Button
                            size="sm"
                            className="h-8 w-[168px]"
                            onClick={() =>
                              onRecordInPerson({
                                title: e.title || "Untitled meeting",
                                calendarEventId: e.id,
                                accountId: e.accountId,
                                scheduledStart: e.start,
                              })
                            }
                          >
                            <Mic className="mr-1.5 h-3.5 w-3.5" /> Record now
                          </Button>
                        )}
                        {e.canResendBot && e.meetingId && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 w-[168px]"
                            disabled={
                              resendMutation.isPending && resendMutation.variables === e.meetingId
                            }
                            onClick={() => resendMutation.mutate(e.meetingId as string)}
                          >
                            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                            {resendMutation.isPending && resendMutation.variables === e.meetingId
                              ? "Sending…"
                              : "Resend notetaker"}
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
