import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { MeetingBotCard } from "@/components/settings/MeetingBotCard";
import { MeetingAutoRecordCard } from "@/components/settings/MeetingAutoRecordCard";
import { MeetingRecordBlocklistCard } from "@/components/settings/MeetingRecordBlocklistCard";
import { useAccountSelection } from "@/lib/account-selection";

export const Route = createFileRoute("/_authenticated/settings/meetings-recording")({
  head: () => ({
    meta: [
      { title: "Meeting recording — Settings — Zerrow" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MeetingRecordingSettings,
});

function MeetingRecordingSettings() {
  const { activeAccountId, setActiveAccountId } = useAccountSelection();
  const [scopedEmail, setScopedEmail] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <MeetingBotCard />

      <AccountPicker
        value={activeAccountId}
        onChange={(id, email) => {
          setActiveAccountId(id);
          setScopedEmail(email);
        }}
        label="Calendar"
      />

      {activeAccountId && scopedEmail && (
        <MeetingAutoRecordCard accountId={activeAccountId} accountEmail={scopedEmail} />
      )}

      <MeetingRecordBlocklistCard />
    </div>
  );
}
