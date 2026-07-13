import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarCog } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { getMeetingEventPrefs, updateMeetingEventPrefs } from "@/lib/meetings.functions";

/** The four special Google entry types the notetaker can hide. */
const EVENT_TYPES = [
  { id: "outOfOffice", label: "Out of office" },
  { id: "workingLocation", label: "Working location (home / office)" },
  { id: "focusTime", label: "Focus time" },
  { id: "birthday", label: "Birthdays" },
] as const;

type SpecialType = (typeof EVENT_TYPES)[number]["id"];

/** Google Calendar's 11 event colors, with a swatch class for each. */
const EVENT_COLORS = [
  { id: "11", name: "Tomato", swatch: "bg-[#d50000]" },
  { id: "6", name: "Tangerine", swatch: "bg-[#f4511e]" },
  { id: "5", name: "Banana", swatch: "bg-[#f6bf26]" },
  { id: "2", name: "Sage", swatch: "bg-[#33b679]" },
  { id: "10", name: "Basil", swatch: "bg-[#0b8043]" },
  { id: "7", name: "Peacock", swatch: "bg-[#039be5]" },
  { id: "9", name: "Blueberry", swatch: "bg-[#3f51b5]" },
  { id: "1", name: "Lavender", swatch: "bg-[#7986cb]" },
  { id: "3", name: "Grape", swatch: "bg-[#8e24aa]" },
  { id: "4", name: "Flamingo", swatch: "bg-[#e67c73]" },
  { id: "8", name: "Graphite", swatch: "bg-[#616161]" },
] as const;

type ColorId = (typeof EVENT_COLORS)[number]["id"];

export function MeetingEventFilterCard() {
  const qc = useQueryClient();
  const getPrefs = useServerFn(getMeetingEventPrefs);
  const savePrefs = useServerFn(updateMeetingEventPrefs);

  const { data } = useQuery({
    queryKey: ["meeting-event-prefs"],
    queryFn: () => getPrefs(),
  });

  const [hidden, setHidden] = useState<Set<SpecialType>>(new Set());
  const [colorSkip, setColorSkip] = useState<Set<ColorId>>(new Set());

  useEffect(() => {
    if (!data) return;
    setHidden(new Set(data.hiddenEventTypes as SpecialType[]));
    setColorSkip(new Set(data.colorSkip as ColorId[]));
  }, [data]);

  const mutation = useMutation({
    mutationFn: (next: { hidden: Set<SpecialType>; colorSkip: Set<ColorId> }) =>
      savePrefs({
        data: {
          hiddenEventTypes: [...next.hidden],
          colorSkip: [...next.colorSkip],
        },
      }),
    onError: () => {
      toast.error("Couldn't save your event preferences.");
      qc.invalidateQueries({ queryKey: ["meeting-event-prefs"] });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["upcoming-calendar-events"] });
    },
  });

  const toggleType = (id: SpecialType, show: boolean) => {
    const next = new Set(hidden);
    // Switch shows "shown" state, so ON removes it from the hidden set.
    if (show) next.delete(id);
    else next.add(id);
    setHidden(next);
    mutation.mutate({ hidden: next, colorSkip });
  };

  const toggleColor = (id: ColorId, record: boolean) => {
    const next = new Set(colorSkip);
    // Switch shows "record" state, so ON removes it from the skip set.
    if (record) next.delete(id);
    else next.add(id);
    setColorSkip(next);
    mutation.mutate({ hidden, colorSkip: next });
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start gap-3 border-b bg-muted/20 p-4 md:p-6">
        <CalendarCog className="mt-0.5 h-5 w-5 text-muted-foreground" />
        <div>
          <h2 className="font-display text-2xl">Event types &amp; colors</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Control which calendar entries appear in your upcoming meetings and which the notetaker
            will record.
          </p>
        </div>
      </div>

      <div className="space-y-6 p-4 md:p-6">
        <div>
          <p className="text-sm font-medium text-foreground">Show these in the list</p>
          <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
            These aren't real meetings, so they're hidden by default and never recorded.
          </p>
          <ul className="divide-y divide-border">
            {EVENT_TYPES.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                <span className="text-sm text-foreground">{t.label}</span>
                <Switch
                  checked={!hidden.has(t.id)}
                  disabled={mutation.isPending}
                  onCheckedChange={(checked) => toggleType(t.id, checked)}
                  aria-label={`Show ${t.label} in upcoming meetings`}
                />
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-sm font-medium text-foreground">Hide by event color</p>
          <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
            Turn a color off and those events are hidden from your upcoming list and never recorded.
          </p>
          <ul className="divide-y divide-border">
            {EVENT_COLORS.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                <span className="flex items-center gap-2 text-sm text-foreground">
                  <span
                    className={`h-3.5 w-3.5 shrink-0 rounded-full ${c.swatch}`}
                    aria-hidden="true"
                  />
                  {c.name}
                </span>
                <Switch
                  checked={!colorSkip.has(c.id)}
                  disabled={mutation.isPending}
                  onCheckedChange={(checked) => toggleColor(c.id, checked)}
                  aria-label={`Record ${c.name} meetings`}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}
