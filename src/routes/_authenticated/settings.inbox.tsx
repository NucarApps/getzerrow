import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AccountPicker } from "@/components/settings/AccountPicker";
import { InboxOverrides } from "@/components/settings/InboxOverrides";
import { useAccountSelection } from "@/lib/account-selection";

export const Route = createFileRoute("/_authenticated/settings/inbox")({
  head: () => ({
    meta: [
      { title: "Inbox filters — Settings — Zerrow" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: InboxSettings,
});

function InboxSettings() {
  const { activeAccountId, setActiveAccountId } = useAccountSelection();
  const [scopedEmail, setScopedEmail] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <AccountPicker
        value={activeAccountId}
        onChange={(id, email) => {
          setActiveAccountId(id);
          setScopedEmail(email);
        }}
        label="Inbox"
      />
      <InboxOverrides accountId={activeAccountId} accountEmail={scopedEmail} />
    </div>
  );
}
