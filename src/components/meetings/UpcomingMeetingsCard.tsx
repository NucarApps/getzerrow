import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, Video } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { listAllUpcomingCalendarEvents, setEventExclusion } from "@/lib/meetings.functions";

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

export function UpcomingMeetingsCard() {
  const qc = useQueryClient();
  const listEvents = useServerFn(listAllUpcomingCalendarEvents);
  const setExclusion = useServerFn(setEventExclusion);

  const { data, isLoading } = useQuery({
    queryKey: ["upcoming-calendar-events"],
    queryFn: () => listEvents(),
  });

  const mutation = useMutation({
    mutationFn: (vars: { accountId: string; calendarEventId: string; excluded: boolean }) =>
      setExclusion({ data: vars }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["upcoming-calendar-events"] });
      const prev = qc.getQueryData(["upcoming-calendar-events"]);
      qc.setQueryData(["upcoming-calendar-events"], (old: typeof data) =>
        old
          ? {
              ...old,
              events: old.events.map((e) =>
                e.id === vars.calendarEventId ? { ...e, excluded: vars.excluded } : e,
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

  const noCalendar = !!data && !data.calendarAccess;
  const events = data?.events ?? [];
  const recordable = events.filter((e) => e.hasMeetingLink);
  const multipleAccounts = new Set(recordable.map((e) => e.accountId)).size > 1;

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 md:p-6">
        <CalendarClock className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-display text-lg sm:text-2xl">Upcoming meetings</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Meetings with a Zoom, Meet, or Teams link coming up in the next 14 days. Turn the
            notetaker off for any you'd rather keep private.
          </p>
        </div>
      </div>

      <div className="p-4 md:p-6">
        {noCalendar ? (
          <p className="text-sm text-muted-foreground">
            Calendar access hasn't been granted yet. Connect Google with calendar access in Settings
            to see your upcoming meetings.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your upcoming meetings…</p>
        ) : recordable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming meetings with a Zoom, Meet, or Teams link in the next 14 days.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {recordable.map((e) => {
              const send = !e.excluded;
              return (
                <li key={e.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                      <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {e.title || "Untitled meeting"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatWhen(e.start)}
                      {multipleAccounts && e.accountEmail && ` · ${e.accountEmail}`}
                      {e.scheduled && " · Notetaker scheduled"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-xs text-muted-foreground sm:inline">
                      {send ? "Send notetaker" : "Skipped"}
                    </span>
                    <Switch
                      checked={send}
                      disabled={mutation.isPending}
                      onCheckedChange={(checked) =>
                        mutation.mutate({
                          accountId: e.accountId,
                          calendarEventId: e.id,
                          excluded: !checked,
                        })
                      }
                      aria-label={`Toggle notetaker for ${e.title || "this meeting"}`}
                    />
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
