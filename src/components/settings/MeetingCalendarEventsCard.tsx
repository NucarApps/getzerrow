import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, Video } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { listUpcomingCalendarEvents, setEventExclusion } from "@/lib/meetings.functions";

type Props = { accountId: string | null; accountEmail: string | null };

function formatWhen(iso: string | null): string {
  if (!iso) return "No start time";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MeetingCalendarEventsCard({ accountId, accountEmail }: Props) {
  const qc = useQueryClient();
  const listEvents = useServerFn(listUpcomingCalendarEvents);
  const setExclusion = useServerFn(setEventExclusion);

  const { data, isLoading } = useQuery({
    queryKey: ["calendar-events", accountId],
    queryFn: () => listEvents({ data: { accountId: accountId! } }),
    enabled: !!accountId,
  });

  const mutation = useMutation({
    mutationFn: (vars: { calendarEventId: string; excluded: boolean }) =>
      setExclusion({ data: { accountId: accountId!, ...vars } }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ["calendar-events", accountId] });
      const prev = qc.getQueryData(["calendar-events", accountId]);
      qc.setQueryData(["calendar-events", accountId], (old: typeof data) =>
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
      if (ctx?.prev) qc.setQueryData(["calendar-events", accountId], ctx.prev);
      toast.error("Couldn't update that event.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["calendar-events", accountId] });
    },
  });

  if (!accountId) return null;

  const noCalendar = !!data && !data.calendarAccess;
  const events = data?.events ?? [];
  const recordable = events.filter((e) => e.hasMeetingLink);

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 md:p-6">
        <CalendarClock className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-display text-2xl">Upcoming meetings</h2>
          {accountEmail && (
            <p className="mt-0.5 text-sm font-medium text-foreground">{accountEmail}</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            Turn the notetaker off for any meeting you'd rather keep private. This only applies when
            auto-record is on for this inbox.
          </p>
        </div>
      </div>

      <div className="p-4 md:p-6">
        {noCalendar ? (
          <p className="text-sm text-muted-foreground">
            Calendar access hasn't been granted yet. Reconnect Google in the calendar guard above to
            see your upcoming meetings.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your upcoming meetings…</p>
        ) : data && "error" in data && data.error ? (
          <p className="text-sm text-muted-foreground">{data.error}</p>
        ) : recordable.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No upcoming meetings with a Zoom, Meet, or Teams link in the next 14 days.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {recordable.map((e) => {
              const send = !e.excluded && !e.blocked;
              return (
                <li key={e.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                      <Video className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {e.title || "Untitled meeting"}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {formatWhen(e.start)}
                      {e.scheduled && !e.blocked && " · Notetaker scheduled"}
                    </p>
                    {e.blocked && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Guest on your don't-record list — won't be recorded.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {e.blocked ? "Blocked" : send ? "Send notetaker" : "Skipped"}
                    </span>
                    <Switch
                      checked={send}
                      disabled={mutation.isPending || e.blocked}
                      onCheckedChange={(checked) => {
                        if (e.blocked) return;
                        mutation.mutate({ calendarEventId: e.id, excluded: !checked });
                      }}
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
