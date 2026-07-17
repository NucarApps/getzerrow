import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { RefreshCw, AlertCircle, Loader2 } from "lucide-react";
import { listMyGmailAccounts, startConnectGmail } from "@/lib/gmail/accounts.functions";
import {
  syncGoogleContactsNow,
  getGoogleContactsSyncStatus,
  setGoogleContactsSyncMode,
} from "@/lib/google-contacts.functions";

type SyncMode = "off" | "pull_only" | "two_way";

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
    return "Google did not grant Contacts access. On the consent screen, tick the \u201cSee, edit, download and permanently delete your contacts\u201d checkbox, then reconnect.";
  if (err === "sync_disabled") return "Sync is turned off for this account.";
  if (err === "locked") return "Another sync is already running — it should finish within about 90 seconds.";
  return err;
}

function AccountRow({ account }: { account: { id: string; email_address: string; needs_reauth: boolean } }) {
  const qc = useQueryClient();
  const getStatus = useServerFn(getGoogleContactsSyncStatus);
  const syncNow = useServerFn(syncGoogleContactsNow);
  const setMode = useServerFn(setGoogleContactsSyncMode);
  const connect = useServerFn(startConnectGmail);
  const [reconnecting, setReconnecting] = useState(false);
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);

  const statusQ = useQuery({
    queryKey: ["google-contacts-status", account.id],
    queryFn: () => getStatus({ data: { accountId: account.id } }),
    refetchInterval: (q) => (q.state.data?.state?.locked_at ? 1_000 : 15_000),
  });

  const state = statusQ.data?.state;
  const isRunning = !!state?.locked_at;
  const step = state?.progress_step ?? null;
  const processed = state?.progress_processed ?? 0;
  const total = state?.progress_total ?? 0;

  const mode: SyncMode =
    (state?.sync_mode as SyncMode | undefined) ??
    (state?.enabled ? "two_way" : "off");
  const enabled = mode !== "off";
  const scopeGranted = statusQ.data?.scope_granted ?? null;
  const rawLastError = statusQ.data?.state?.last_error ?? null;
  const lastError =
    scopeGranted === false
      ? "missing_contacts_scope"
      : scopeGranted === true && rawLastError === "missing_contacts_scope"
        ? null
        : rawLastError;

  const modeMut = useMutation({
    mutationFn: (next: SyncMode) =>
      setMode({ data: { accountId: account.id, mode: next } }),
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
          mode === "pull_only"
            ? `Imported ${res.pull ?? 0} from Google`
            : `Synced ${res.pull ?? 0} pulled, ${res.push ?? 0} pushed`,
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

  function handleModeChange(next: string) {
    const nextMode = next as SyncMode;
    if (nextMode === mode) return;
    if (mode === "pull_only" && nextMode === "two_way") {
      setConfirmUpgrade(true);
      return;
    }
    modeMut.mutate(nextMode);
  }

  const errorMsg = friendlyError(lastError);
  const needsReconnect = account.needs_reauth || lastError === "needs_reconnect" || lastError === "missing_contacts_scope";

  return (
    <Card className="p-4 md:p-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{account.email_address}</p>
            {mode === "pull_only" && (
              <Badge variant="secondary" className="text-[10px]">Pull only</Badge>
            )}
            {mode === "two_way" && (
              <Badge className="text-[10px]">Two-way</Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Last sync: {formatWhen(statusQ.data?.state?.last_incremental_at)}
          </p>
          {statusQ.data?.state && <PullBreakdown state={statusQ.data.state} />}
        </div>

        <div className="flex flex-col items-start gap-2 md:items-end">
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

      <div className="mt-4 border-t pt-4">
        <RadioGroup
          value={mode}
          onValueChange={handleModeChange}
          disabled={modeMut.isPending || needsReconnect}
          className="space-y-2"
        >
          <ModeOption
            id={`mode-off-${account.id}`}
            value="off"
            title="Off"
            description="Nothing syncs with Google Contacts."
          />
          <ModeOption
            id={`mode-pull-${account.id}`}
            value="pull_only"
            title="Pull only (import from Google)"
            description="Import contacts and groups from Google into Zerrow so you can merge duplicates and clean up. Local changes are not pushed back."
          />
          <ModeOption
            id={`mode-two-${account.id}`}
            value="two_way"
            title="Two-way sync"
            description="Pull from Google and push local changes, adds, and deletes back to Google."
          />
        </RadioGroup>
      </div>

      {isRunning && (
        <div className="mt-3 rounded-md border bg-muted/40 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span>{stepLabel(step)}</span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {total > 0 ? `${processed} / ${total}` : `${processed}`}
            </span>
          </div>
          <Progress
            className="mt-2 h-1.5"
            value={total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : undefined}
          />
        </div>
      )}

      {errorMsg && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{errorMsg}</span>
        </div>
      )}

      <AlertDialog open={confirmUpgrade} onOpenChange={setConfirmUpgrade}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on two-way sync?</AlertDialogTitle>
            <AlertDialogDescription>
              Local changes, additions, and deletions since you imported from Google
              will start pushing to your Google Contacts on the next sync. Make sure
              you're done merging and cleaning up first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmUpgrade(false);
                modeMut.mutate("two_way");
              }}
            >
              Enable two-way
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ModeOption({
  id,
  value,
  title,
  description,
}: {
  id: string;
  value: SyncMode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {title}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function stepLabel(step: string | null): string {
  switch (step) {
    case "starting":
      return "Starting sync…";
    case "pulling_groups":
      return "Pulling groups from Google";
    case "pulling_contacts":
      return "Pulling contacts from Google";
    case "pushing_groups":
      return "Pushing groups to Google";
    case "pushing_contacts":
      return "Pushing contacts to Google";
    case "applying_tombstones":
      return "Applying deletions";
    case "finalizing":
      return "Finalizing…";
    case "done":
      return "Done";
    default:
      return "Working…";
  }
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
          Start with <strong>Pull only</strong> to import your Google contacts and
          groups into Zerrow so you can merge duplicates and clean things up. When
          you're ready, switch to <strong>Two-way</strong> to also push local
          changes, adds, and deletes back to Google.
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
