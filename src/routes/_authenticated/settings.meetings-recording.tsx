import { createFileRoute } from "@tanstack/react-router";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { MeetingBotCard } from "@/components/settings/MeetingBotCard";
import { MeetingAutoRecordCard } from "@/components/settings/MeetingAutoRecordCard";
import { MeetingRecordBlocklistCard } from "@/components/settings/MeetingRecordBlocklistCard";
import { useScopedAccount } from "@/lib/use-scoped-account";

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
  const { activeAccountId, scopedEmail, onAccountChange } = useScopedAccount();

  return (
    <div className="space-y-6">
      <MeetingBotCard />

      <AccountPicker value={activeAccountId} onChange={onAccountChange} label="Calendar" />

      {activeAccountId && scopedEmail && (
        <MeetingAutoRecordCard accountId={activeAccountId} accountEmail={scopedEmail} />
      )}

      <MeetingRecordBlocklistCard />
    </div>
  );
}
