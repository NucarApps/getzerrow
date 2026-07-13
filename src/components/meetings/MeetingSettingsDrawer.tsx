import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { listMyGmailAccounts } from "@/lib/gmail.functions";
import { CalendarGuardCard } from "@/components/settings/CalendarGuardCard";
import { MeetingAutoRecordCard } from "@/components/settings/MeetingAutoRecordCard";
import { MeetingCalendarSelectCard } from "@/components/settings/MeetingCalendarSelectCard";
import { MeetingCalendarEventsCard } from "@/components/settings/MeetingCalendarEventsCard";
import { MeetingEventFilterCard } from "@/components/settings/MeetingEventFilterCard";
import { MeetingBotCard } from "@/components/settings/MeetingBotCard";
import { MeetingRecordBlocklistCard } from "@/components/settings/MeetingRecordBlocklistCard";

export function MeetingSettingsDrawer() {
  const [open, setOpen] = useState(false);
  const listAccounts = useServerFn(listMyGmailAccounts);

  const accountsQ = useQuery({
    queryKey: ["gmail-accounts"],
    queryFn: () => listAccounts(),
    enabled: open,
  });

  const accounts = accountsQ.data?.accounts ?? [];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Meeting settings"
        title="Meeting settings"
        className="h-8 w-8 sm:h-10 sm:w-10"
      >
        <Settings className="h-4 w-4" />
      </Button>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <SheetHeader className="space-y-1 border-b border-border p-4 pb-3 text-left sm:p-6 sm:pb-4">
          <SheetTitle className="text-base sm:text-lg">Meeting settings</SheetTitle>
          <SheetDescription>
            Control the notetaker bot, auto-recording, and which calendar meetings get recorded.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-4 sm:p-6">
          <MeetingBotCard />

          {accounts.map((a) => (
            <CalendarGuardCard key={a.id} accountId={a.id} accountEmail={a.email_address} />
          ))}

          {accounts.map((a) => (
            <div key={a.id} className="space-y-6">
              <MeetingAutoRecordCard accountId={a.id} accountEmail={a.email_address} />
              <MeetingCalendarSelectCard accountId={a.id} accountEmail={a.email_address} />
            </div>
          ))}

          <MeetingEventFilterCard />

          <MeetingRecordBlocklistCard />


          {accounts.map((a) => (
            <MeetingCalendarEventsCard key={a.id} accountId={a.id} accountEmail={a.email_address} />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
