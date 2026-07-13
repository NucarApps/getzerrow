import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { CalendarGuardCard } from "@/components/settings/CalendarGuardCard";
import { MeetingCalendarSelectCard } from "@/components/settings/MeetingCalendarSelectCard";
import { MeetingEventFilterCard } from "@/components/settings/MeetingEventFilterCard";
import { MeetingCalendarEventsCard } from "@/components/settings/MeetingCalendarEventsCard";
import { useAccountSelection } from "@/lib/account-selection";

export const Route = createFileRoute("/_authenticated/settings/meetings-calendar")({
  head: () => ({
    meta: [
      { title: "Meeting calendar — Settings — Zerrow" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MeetingCalendarSettings,
});

function MeetingCalendarSettings() {
  const { activeAccountId, setActiveAccountId } = useAccountSelection();
  const [scopedEmail, setScopedEmail] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <AccountPicker
        value={activeAccountId}
        onChange={(id, email) => {
          setActiveAccountId(id);
          setScopedEmail(email);
        }}
        label="Calendar"
      />

      {activeAccountId && scopedEmail && (
        <>
          <CalendarGuardCard accountId={activeAccountId} accountEmail={scopedEmail} />
          <MeetingCalendarSelectCard accountId={activeAccountId} accountEmail={scopedEmail} />
        </>
      )}

      <MeetingEventFilterCard />

      {activeAccountId && scopedEmail && (
        <MeetingCalendarEventsCard accountId={activeAccountId} accountEmail={scopedEmail} />
      )}
    </div>
  );
}
