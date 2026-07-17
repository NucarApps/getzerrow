import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { RefreshCw, AlertCircle } from "lucide-react";
import { listMyGmailAccounts, startConnectGmail } from "@/lib/gmail/accounts.functions";
import {
  syncGoogleContactsNow,
  getGoogleContactsSyncStatus,
  setGoogleContactsSyncEnabled,
} from "@/lib/google-contacts.functions";

export const Route = createFileRoute("/_authenticated/settings/google-contacts")({
  head: () => ({
    meta: [
      { title: "Google contacts sync — Settings — Zerrow" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: GoogleContactsSettings,
});

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString();
}

function friendlyError(err: string | null | undefined): string | null {
  if (!err) return null;
  if (err === "needs_reconnect")
    return "Google connection expired. Reconnect this account to resume syncing.";
  if (err === "missing_contacts_scope")
    return "Contacts permission not granted. Reconnect to authorise access.";
  if (err === "sync_disabled") return "Sync is turned off for this account.";
  if (err === "locked") return "Another sync is already running. It will retry shortly.";
  return err;
}

function AccountRow({ account }: { account: { id: string; email_address: string; needs_reauth: boolean } }) {
  const qc = useQueryClient();
  const getStatus = useServerFn(getGoogleContactsSyncStatus);
  const syncNow = useServerFn(syncGoogleContactsNow);
  const setEnabled = useServerFn(setGoogleContactsSyncEnabled);
  const connect = useServerFn(startConnectGmail);
  const [reconnecting, setReconnecting] = useState(false);

  const statusQ = useQuery({
    queryKey: ["google-contacts-status", account.id],
    queryFn: () => getStatus({ data: { accountId: account.id } }),
    refetchInterval: 15_000,
  });

  const enabled = statusQ.data?.state?.enabled ?? false;
  const lastError = statusQ.data?.state?.last_error ?? null;

  const toggleMut = useMutation({
    mutationFn: (next: boolean) =>
      setEnabled({ data: { accountId: account.id, enabled: next } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["google-contacts-status", account.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const syncMut = useMutation({
    mutationFn: () => syncNow({ data: { accountId: account.id } }),
    onSuccess: (res) => {
      if (res.ok) {
        toast.success(
          `Synced ${res.pull ?? 0} pulled, ${res.push ?? 0} pushed`,
        );
      } else {
        toast.error(friendlyError(res.error) ?? "Sync failed");
      }
      qc.invalidateQueries({ queryKey: ["google-contacts-status", account.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function handleReconnect() {
    setReconnecting(true);
    try {
      const { url } = await connect({ data: { login_hint: account.email_address } });
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start reconnect");
      setReconnecting(false);
    }
  }

  const errorMsg = friendlyError(lastError);
  const needsReconnect = account.needs_reauth || lastError === "needs_reconnect" || lastError === "missing_contacts_scope";

  return (
    <Card className="p-4 md:p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="truncate font-medium">{account.email_address}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Last sync: {formatWhen(statusQ.data?.state?.last_incremental_at)}
          </p>
          {statusQ.data?.state && (
            <p className="text-xs text-muted-foreground">
              Pulled {statusQ.data.state.last_pull_count ?? 0} · Pushed{" "}
              {statusQ.data.state.last_push_count ?? 0}
            </p>
          )}
        </div>

        <div className="flex flex-col items-start gap-2 md:items-end">
          <div className="flex items-center gap-2">
            <Label htmlFor={`enabled-${account.id}`} className="text-sm">
              Sync enabled
            </Label>
            <Switch
              id={`enabled-${account.id}`}
              checked={enabled}
              disabled={toggleMut.isPending || needsReconnect}
              onCheckedChange={(v) => toggleMut.mutate(v)}
            />
          </div>
          <div className="flex gap-2">
            {needsReconnect ? (
              <Button size="sm" onClick={handleReconnect} disabled={reconnecting}>
                {reconnecting ? "Redirecting…" : "Reconnect"}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => syncMut.mutate()}
                disabled={!enabled || syncMut.isPending}
              >
                <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${syncMut.isPending ? "animate-spin" : ""}`} />
                Sync now
              </Button>
            )}
          </div>
        </div>
      </div>

      {errorMsg && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{errorMsg}</span>
        </div>
      )}
    </Card>
  );
}

function GoogleContactsSettings() {
  const list = useServerFn(listMyGmailAccounts);
  const accountsQ = useQuery({ queryKey: ["gmail-accounts"], queryFn: () => list() });
  const accounts = accountsQ.data?.accounts ?? [];

  return (
    <div className="space-y-6">
      <Card className="p-4 md:p-6">
        <h2 className="font-display text-2xl">Google contacts sync</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Two-way sync with Google Contacts. Changes made in Zerrow push to Google, and
          changes made in Google Contacts (including on your phone) pull back into Zerrow.
          Contact groups map to Google labels, and deletions propagate both ways.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          The background sync runs every 15 minutes. Use "Sync now" for an immediate run.
        </p>
      </Card>

      {accountsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading accounts…</p>
      ) : accounts.length === 0 ? (
        <Card className="p-4 md:p-6">
          <p className="text-sm text-muted-foreground">
            Connect a Gmail account from the Accounts settings first.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
        </div>
      )}
    </div>
  );
}
