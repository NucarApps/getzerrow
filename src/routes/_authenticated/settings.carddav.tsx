import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Copy, Smartphone, Trash2 } from "lucide-react";
import {
  createCardDavToken,
  listCardDavTokens,
  revokeCardDavToken,
} from "@/lib/carddav/tokens.functions";
import {
  getCardDavSettings,
  updateCardDavSettings,
  forceCarddavResync,
  type GroupNameStyle,
} from "@/lib/carddav/settings.functions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const Route = createFileRoute("/_authenticated/settings/carddav")({
  head: () => ({
    meta: [
      { title: "iPhone contacts — Settings — Zerrow" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CardDavSettings,
});

function useUserEmail(): string | null {
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);
  return email;
}

function CardDavSettings() {
  const email = useUserEmail();
  const qc = useQueryClient();
  const list = useServerFn(listCardDavTokens);
  const create = useServerFn(createCardDavToken);
  const revoke = useServerFn(revokeCardDavToken);
  const getSettings = useServerFn(getCardDavSettings);
  const updateSettings = useServerFn(updateCardDavSettings);
  const forceResync = useServerFn(forceCarddavResync);
  const [label, setLabel] = useState("iPhone");
  const [freshToken, setFreshToken] = useState<string | null>(null);

  const settingsQuery = useQuery({
    queryKey: ["carddav-settings"],
    queryFn: () => getSettings(),
  });
  const settingsMut = useMutation({
    mutationFn: (patch: { group_name_style?: GroupNameStyle; include_summary_in_notes?: boolean }) =>
      updateSettings({ data: patch }),
    onSuccess: () => {
      toast.success("iPhone will refresh on next sync");
      qc.invalidateQueries({ queryKey: ["carddav-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const resyncMut = useMutation({
    mutationFn: () => forceResync(),
    onSuccess: () =>
      toast.success(
        "Address book tag bumped — iPhone will pull a fresh copy on next sync",
      ),
    onError: (e: Error) => toast.error(e.message),
  });

  const tokensQuery = useQuery({
    queryKey: ["carddav-tokens"],
    queryFn: () => list(),
  });

  const createMut = useMutation({
    mutationFn: () => create({ data: { label: label.trim() || "iPhone" } }),
    onSuccess: (res) => {
      setFreshToken(res.token);
      setLabel("iPhone");
      qc.invalidateQueries({ queryKey: ["carddav-tokens"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => revoke({ data: { id } }),
    onSuccess: () => {
      toast.success("Device disconnected");
      qc.invalidateQueries({ queryKey: ["carddav-tokens"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const serverUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api/public/carddav/` : "/api/public/carddav/";

  const copy = async (value: string, note: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(note);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">iPhone contacts</h2>
        <p className="text-sm text-muted-foreground">
          Two-way sync between Zerrow and your iPhone over CardDAV. Edits, adds, and deletes on your phone
          push back to Zerrow — deleting a contact on iPhone removes it here too. iOS uses incremental
          sync (RFC 6578), so refreshes only fetch what actually changed.
        </p>

      </div>

      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <Smartphone className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div className="flex-1 space-y-3">
            <div>
              <p className="font-medium">1. Create a device password</p>
              <p className="text-sm text-muted-foreground">
                Each iPhone uses its own password. You'll only see the value once.
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Device label (e.g. iPhone 15)"
                maxLength={60}
              />
              <Button
                onClick={() => createMut.mutate()}
                disabled={createMut.isPending}
              >
                {createMut.isPending ? "Creating…" : "Create password"}
              </Button>
            </div>
            {freshToken ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/40">
                <p className="text-sm font-medium">Copy this now — it won't be shown again</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-background px-2 py-1 text-sm">
                    {freshToken}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copy(freshToken, "Password copied")}
                  >
                    <Copy className="mr-1 h-3 w-3" />
                    Copy
                  </Button>
                </div>
                <button
                  className="mt-2 text-xs text-muted-foreground underline"
                  onClick={() => setFreshToken(null)}
                >
                  I've saved it — hide
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <div>
          <p className="font-medium">2. Add the account on your iPhone</p>
          <p className="text-sm text-muted-foreground">
            Settings → Contacts → Accounts → Add Account → Other → Add CardDAV Account.
          </p>
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Server</dt>
          <dd className="flex items-center gap-2">
            <code className="truncate rounded bg-muted px-2 py-0.5">{serverUrl}</code>
            <Button size="sm" variant="ghost" onClick={() => copy(serverUrl, "Server URL copied")}>
              <Copy className="h-3 w-3" />
            </Button>
          </dd>
          <dt className="text-muted-foreground">User Name</dt>
          <dd>
            <code className="rounded bg-muted px-2 py-0.5">{email ?? "…"}</code>
          </dd>
          <dt className="text-muted-foreground">Password</dt>
          <dd className="text-muted-foreground">The device password you just created.</dd>
          <dt className="text-muted-foreground">Description</dt>
          <dd className="text-muted-foreground">Zerrow (optional)</dd>
        </dl>
      </Card>

      <Card className="p-5">
        <p className="mb-3 font-medium">Connected devices</p>
        {tokensQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (tokensQuery.data?.tokens.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            No devices yet. Create a password above and add it on your iPhone.
          </p>
        ) : (
          <ul className="divide-y">
            {tokensQuery.data?.tokens.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="font-medium">{t.label}</p>
                  <p className="text-xs text-muted-foreground">
                    Created {new Date(t.created_at).toLocaleDateString("en-US")} ·{" "}
                    {t.last_used_at
                      ? `Last synced ${new Date(t.last_used_at).toLocaleString("en-US")}`
                      : "Never synced"}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => revokeMut.mutate(t.id)}
                  disabled={revokeMut.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-3 p-5">
        <div>
          <p className="font-medium">Group names on iPhone</p>
          <p className="text-sm text-muted-foreground">
            iOS Contacts only shows a flat list of groups, so nested Zerrow
            groups (like Factory → Toyota) need a display style. Changing this
            triggers a group-name refresh on next sync — no need to remove
            the account.
          </p>
        </div>
        <div className="max-w-sm">
          <Label className="mb-1 block text-sm">Display format</Label>
          <Select
            value={settingsQuery.data?.group_name_style ?? "path_slash"}
            onValueChange={(v) => settingsMut.mutate(v as GroupNameStyle)}
            disabled={settingsQuery.isLoading || settingsMut.isPending}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="leaf">Leaf name only — "Toyota"</SelectItem>
              <SelectItem value="path_slash">Parent / Child — "Factory / Toyota"</SelectItem>
              <SelectItem value="path_dash">Parent - Child — "Factory - Toyota"</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="border-t pt-4">
          <p className="text-sm font-medium">Force iPhone resync</p>
          <p className="mb-2 text-sm text-muted-foreground">
            Bumps the address-book tag so your iPhone pulls a fresh copy on
            its next sync (usually within 15 min, or immediately if you open
            Contacts and pull to refresh). Use this after group changes that
            aren't showing up.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => resyncMut.mutate()}
            disabled={resyncMut.isPending}
          >
            {resyncMut.isPending ? "Bumping…" : "Force iPhone resync"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
