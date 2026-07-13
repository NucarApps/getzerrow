import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarRange } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  listAccountCalendars,
  saveCalendarSelections,
  type AccountCalendar,
} from "@/lib/meetings.functions";

type Props = { accountId: string | null; accountEmail: string | null };

export function MeetingCalendarSelectCard({ accountId, accountEmail }: Props) {
  const qc = useQueryClient();
  const listCalendars = useServerFn(listAccountCalendars);
  const saveSelections = useServerFn(saveCalendarSelections);

  const { data, isLoading } = useQuery({
    queryKey: ["account-calendars", accountId],
    queryFn: () => listCalendars({ data: { accountId: accountId! } }),
    enabled: !!accountId,
  });


  const mutation = useMutation({
    mutationFn: (calendars: AccountCalendar[]) =>
      saveSelections({
        data: {
          accountId: accountId!,
          calendars: calendars.map((c) => ({
            calendarId: c.id,
            calendarSummary: c.summary,
            enabled: c.enabled,
          })),
        },
      }),
    onMutate: async (calendars) => {
      await qc.cancelQueries({ queryKey: ["account-calendars", accountId] });
      const prev = qc.getQueryData(["account-calendars", accountId]);
      qc.setQueryData(["account-calendars", accountId], (old: typeof data) =>
        old ? { ...old, calendars } : old,
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["account-calendars", accountId], ctx.prev);
      toast.error("Couldn't update your calendar selection.");
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["account-calendars", accountId] });
      qc.invalidateQueries({ queryKey: ["calendar-events", accountId] });
      qc.invalidateQueries({ queryKey: ["upcoming-calendar-events"] });
    },
  });

  if (!accountId) return null;


  const calendars = data?.calendars ?? [];
  const noCalendar = !!data && !data.calendarAccess;

  const handleToggle = (calendarId: string, enabled: boolean) => {
    const next = calendars.map((c) => (c.id === calendarId ? { ...c, enabled } : c));
    mutation.mutate(next);
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 md:p-6">
        <CalendarRange className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-display text-2xl">Calendars to show</h2>
          {accountEmail && (
            <p className="mt-0.5 text-sm font-medium text-foreground">{accountEmail}</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            Choose which calendars under this inbox appear in your upcoming meetings. Meetings on
            unselected calendars are hidden and never recorded.
          </p>
        </div>

      </div>

      <div className="p-4 md:p-6">
        {noCalendar ? (
          <p className="text-sm text-muted-foreground">
            Calendar access hasn't been granted yet. Reconnect Google in the calendar guard above.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading your calendars…</p>
        ) : data && "error" in data && data.error ? (
          <p className="text-sm text-muted-foreground">{data.error}</p>
        ) : calendars.length === 0 ? (
          <p className="text-sm text-muted-foreground">No calendars found for this inbox.</p>
        ) : (
          <ul className="divide-y divide-border">
            {calendars.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                    {c.summary || c.id}
                    {c.primary && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Main
                      </span>
                    )}
                  </p>
                </div>
                <Switch
                  checked={c.enabled}
                  disabled={mutation.isPending}
                  onCheckedChange={(checked) => handleToggle(c.id, checked)}
                  aria-label={`Toggle recording for ${c.summary || c.id}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
