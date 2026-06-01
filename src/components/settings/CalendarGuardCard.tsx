import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { CalendarCheck, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  getCalendarGuardStatus,
  setCalendarGuard,
  syncCalendarNow,
} from "@/lib/calendar.functions";
import { startConnectGmail } from "@/lib/gmail.functions";

type Props = { accountId: string | null; accountEmail: string | null };

type SyncReason = "reconnect" | "api_disabled" | "rate_limited" | "unknown";

const REASON_MESSAGE: Record<SyncReason, string> = {
  reconnect: "Reconnect Google to grant calendar access.",
  api_disabled:
    "The Google Calendar API isn't enabled for this connection yet. This is a one-time setup in Google Cloud — once enabled, syncing will work.",
  rate_limited: "Google is rate-limiting calendar requests. Try again in a few minutes.",
  unknown: "Couldn't sync your calendar. Please try again.",
};

export function CalendarGuardCard({ accountId, accountEmail }: Props) {
  const qc = useQueryClient();
  const getStatus = useServerFn(getCalendarGuardStatus);
  const setGuard = useServerFn(setCalendarGuard);
  const syncNow = useServerFn(syncCalendarNow);
  const connect = useServerFn(startConnectGmail);
  const [busy, setBusy] = useState(false);

  const { data: status } = useQuery({
    queryKey: ["calendar-guard", accountId],
    queryFn: () => getStatus({ data: { accountId: accountId! } }),
    enabled: !!accountId,
  });

  if (!accountId) return null;

  const refresh = () => qc.invalidateQueries({ queryKey: ["calendar-guard", accountId] });

  const handleToggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await setGuard({ data: { accountId, enabled } });
      if (enabled && r.synced) {
        toast.success(`Guard on — found ${r.synced.contacts} people you've met.`);
      } else if (enabled && !r.calendarAccess) {
        toast.info("Reconnect Google to grant calendar access.");
      } else if (enabled && r.syncReason) {
        toast.info(REASON_MESSAGE[r.syncReason as SyncReason] ?? REASON_MESSAGE.unknown);
      } else {
        toast.success(enabled ? "Calendar guard turned on." : "Calendar guard turned off.");
      }
      refresh();
    } catch {
      toast.error("Couldn't update the calendar guard.");
    } finally {
      setBusy(false);
    }
  };

  const handleReconnect = async () => {
    setBusy(true);
    try {
      const { url } = await connect({ data: { login_hint: accountEmail ?? undefined } });
      window.location.href = url;
    } catch {
      toast.error("Couldn't start Google reconnect.");
      setBusy(false);
    }
  };

  const handleSyncNow = async () => {
    setBusy(true);
    try {
      const r = await syncNow({ data: { accountId } });
      if (r.ok) {
        toast.success(`Synced — ${r.contacts} people you've met.`);
      } else {
        toast.info(REASON_MESSAGE[r.reason as SyncReason] ?? REASON_MESSAGE.unknown);
      }
      refresh();
    } catch {
      toast.error("Couldn't sync your calendar.");
    } finally {
      setBusy(false);
    }
  };

  const syncedLabel = status?.syncedAt
    ? new Date(status.syncedAt).toLocaleString("en-US")
    : "never";

  // A genuine auth/scope problem needs a reconnect; other errors (e.g. the
  // Calendar API not being enabled) do not — show the real reason instead.
  const needsReconnect = !!status && !status.calendarAccess;

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-start justify-between gap-4 border-b bg-muted/20 p-4 md:p-6">
        <div className="flex items-start gap-3">
          <CalendarCheck className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="font-display text-2xl">Calendar cold-email guard</h2>
            {accountEmail && (
              <p className="mt-0.5 text-sm font-medium text-foreground">{accountEmail}</p>
            )}
            <p className="mt-1 text-sm text-muted-foreground">
              Anyone you've had a meeting with in Google Calendar (last 12 months) is kept in your
              inbox and never auto-filed as cold email.
            </p>
          </div>
        </div>
        <Switch
          checked={!!status?.enabled}
          onCheckedChange={handleToggle}
          disabled={busy}
          aria-label={`Toggle calendar cold-email guard for ${accountEmail ?? "this inbox"}`}
        />
      </div>

      <div className="space-y-3 p-4 md:p-6">
        {needsReconnect ? (
          <div className="flex flex-col gap-3 rounded-lg border border-dashed p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Calendar access hasn't been granted yet. Reconnect Google to enable this guard.
            </p>
            <Button onClick={handleReconnect} disabled={busy} size="sm">
              Reconnect Google
            </Button>
          </div>
        ) : (
          <>
            {status?.lastError && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p>{status.lastError}</p>
              </div>
            )}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                {status?.contactCount ?? 0} people met · last synced {syncedLabel}
              </p>
              <Button
                onClick={handleSyncNow}
                disabled={busy || !status?.enabled}
                size="sm"
                variant="outline"
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Sync now
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
