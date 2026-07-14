import { createFileRoute } from "@tanstack/react-router";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { InboxOverrides } from "@/components/settings/InboxOverrides";
import { useScopedAccount } from "@/lib/use-scoped-account";

export const Route = createFileRoute("/_authenticated/settings/inbox")({
  head: () => ({
    meta: [{ title: "Inbox filters — Settings — Zerrow" }, { name: "robots", content: "noindex" }],
  }),
  component: InboxSettings,
});

function InboxSettings() {
  const { activeAccountId, scopedEmail, onAccountChange } = useScopedAccount();

  return (
    <div className="space-y-4">
      <AccountPicker value={activeAccountId} onChange={onAccountChange} label="Inbox" />
      <InboxOverrides accountId={activeAccountId} accountEmail={scopedEmail} />
    </div>
  );
}
