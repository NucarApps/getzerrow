import { createFileRoute } from "@tanstack/react-router";
import { Card } from "@/components/ui/card";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { AccountHealthPanel } from "@/components/settings/AccountHealthCard";
import { PubsubActivity } from "@/components/settings/PubsubActivity";
import { ProcessingJobs } from "@/components/settings/ProcessingJobs";
import { useScopedAccount } from "@/lib/use-scoped-account";

export const Route = createFileRoute("/_authenticated/settings/activity")({
  head: () => ({
    meta: [
      { title: "Activity — Settings — Zerrow" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ActivitySettings,
});

function ActivitySettings() {
  const { activeAccountId, scopedEmail, onAccountChange } = useScopedAccount();

  return (
    <div className="space-y-6">
      <AccountPicker value={activeAccountId} onChange={onAccountChange} label="Inbox" />
      <Card className="overflow-hidden p-0">
        <div className="border-b bg-muted/20 p-4 md:p-6">
          <h2 className="font-display text-2xl">Account health</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Live status for {scopedEmail ?? "the selected mailbox"} — auto-refreshes every 15
            seconds.
          </p>
        </div>
        <div className="p-4 md:p-6">
          <AccountHealthPanel accountId={activeAccountId} />
        </div>
      </Card>
      <PubsubActivity accountId={activeAccountId} accountEmail={scopedEmail} />
      <ProcessingJobs accountId={activeAccountId} />
    </div>
  );
}
