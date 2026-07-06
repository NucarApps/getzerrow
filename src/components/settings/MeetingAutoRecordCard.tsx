import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Video } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { getAutoRecordStatus, setAutoRecord, setRecordDeclined } from "@/lib/meetings.functions";

type Props = { accountId: string | null; accountEmail: string | null };

export function MeetingAutoRecordCard({ accountId, accountEmail }: Props) {
  const qc = useQueryClient();
  const getStatus = useServerFn(getAutoRecordStatus);
  const setEnabled = useServerFn(setAutoRecord);
  const setDeclined = useServerFn(setRecordDeclined);
  const [busy, setBusy] = useState(false);
  const [declinedBusy, setDeclinedBusy] = useState(false);

  const { data: status } = useQuery({
    queryKey: ["auto-record", accountId],
    queryFn: () => getStatus({ data: { accountId: accountId! } }),
    enabled: !!accountId,
  });

  if (!accountId) return null;

  const handleToggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      await setEnabled({ data: { accountId, enabled } });
      toast.success(enabled ? "Auto-record turned on." : "Auto-record turned off.");
      qc.invalidateQueries({ queryKey: ["auto-record", accountId] });
    } catch {
      toast.error("Couldn't update auto-record.");
    } finally {
      setBusy(false);
    }
  };

  const handleDeclinedToggle = async (enabled: boolean) => {
    setDeclinedBusy(true);
    try {
      await setDeclined({ data: { accountId, enabled } });
      toast.success(
        enabled
          ? "Now recording meetings you've declined."
          : "No longer recording meetings you've declined.",
      );
      qc.invalidateQueries({ queryKey: ["auto-record", accountId] });
      qc.invalidateQueries({ queryKey: ["calendar-events", accountId] });
    } catch {
      toast.error("Couldn't update that setting.");
    } finally {
      setDeclinedBusy(false);
    }
  };

  const noCalendar = !!status && !status.calendarAccess;

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start justify-between gap-4 border-b bg-muted/20 p-4 md:p-6">
        <div className="flex items-start gap-3">
          <Video className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="font-display text-2xl">Auto-record meetings</h2>
            {accountEmail && (
              <p className="mt-0.5 text-sm font-medium text-foreground">{accountEmail}</p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              Automatically send a notetaker to upcoming Google Calendar meetings that have a Zoom,
              Meet, or Teams link. Recordings, transcripts, and summaries land in Meetings.
            </p>
          </div>
        </div>
        <Switch
          checked={!!status?.enabled}
          onCheckedChange={handleToggle}
          disabled={busy || noCalendar}
          aria-label={`Toggle auto-record for ${accountEmail ?? "this inbox"}`}
        />
      </div>
      {noCalendar ? (
        <div className="p-4 md:p-6">
          <p className="text-sm text-muted-foreground">
            Calendar access hasn't been granted yet. Reconnect Google (in the calendar guard above)
            to enable auto-record.
          </p>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-4 p-4 md:p-6">
          <div>
            <h3 className="text-sm font-medium text-foreground">Record meetings I've declined</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Send the notetaker even to meetings you've declined or aren't attending. Off by
              default, so declined meetings are skipped.
            </p>
          </div>
          <Switch
            checked={!!status?.recordDeclined}
            onCheckedChange={handleDeclinedToggle}
            disabled={declinedBusy || !status?.enabled}
            aria-label={`Toggle recording declined meetings for ${accountEmail ?? "this inbox"}`}
          />
        </div>
      )}
    </Card>
  );
}
