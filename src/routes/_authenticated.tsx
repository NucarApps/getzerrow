import {
  createFileRoute,
  redirect,
  Outlet,
  Link,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listGmailLabels, listMyGmailAccounts } from "@/lib/gmail.functions";
import { getAdminMe } from "@/lib/admin.functions";
import {
  Inbox,
  Settings,
  LogOut,
  Plus,
  Pencil,
  Menu,
  BarChart3,
  Users,
  Video,
  Shield,
  CheckCircle2,
  Layers,
  CircleDashed,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FolderSelectionProvider,
  useFolderSelection,
  type FolderSelection,
} from "@/lib/folder-selection";
import { AccountSelectionProvider, useAccountSelection } from "@/lib/account-selection";
import { AccountSwitcher } from "@/components/AccountSwitcher";
import { AddFolderDialog } from "@/components/folders/AddFolderDialog";
import { EditFolderDialog } from "@/components/folders/EditFolderDialog";
import type { Folder, GLabel } from "@/components/folders/FolderEditor";
import { FOLDER_COLUMNS } from "@/components/folders/editor/types";
import { useEmailRealtime } from "@/lib/use-email-realtime";
import { useContactsRealtime } from "@/lib/use-contacts-realtime";
import { BackfillBanner } from "@/components/inbox/BackfillBanner";
import { ReconnectBanner } from "@/components/inbox/ReconnectBanner";
import zerrowLogo from "@/assets/zerrow-logo-v2.png";

const SPECIAL_VIEWS = ["all", "all_mail", "no_rules"];

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    if (typeof window === "undefined") return; // session lives in localStorage
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/login" });
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  useEmailRealtime();
  useContactsRealtime();

  return (
    <AccountSelectionProvider>
      <FolderSelectionProvider>
        <AuthedLayoutInner mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      </FolderSelectionProvider>
    </AccountSelectionProvider>
  );
}

function AuthedLayoutInner({
  mobileOpen,
  setMobileOpen,
}: {
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
}) {
  const { activeAccountId, setActiveAccountId } = useAccountSelection();
  const { setSelected } = useFolderSelection();
  const listAccounts = useServerFn(listMyGmailAccounts);
  const accountsQ = useQuery({ queryKey: ["gmail-accounts"], queryFn: () => listAccounts() });
  const accounts = useMemo(() => accountsQ.data?.accounts ?? [], [accountsQ.data]);

  useEffect(() => {
    if (accounts.length === 0) return;
    const activeExists =
      activeAccountId && accounts.some((account) => account.id === activeAccountId);
    if (activeExists) return;
    setActiveAccountId(accounts[0].id);
    setSelected("all");
  }, [accounts, activeAccountId, setActiveAccountId, setSelected]);

  return (
    <div className="relative flex h-[100dvh] overflow-hidden bg-background text-foreground">
      {/* Mission Control atmospheric backdrop */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(255,107,61,0.10), transparent 70%)," +
            "radial-gradient(ellipse 70% 50% at 80% 40%, rgba(107,209,224,0.05), transparent 70%)," +
            "linear-gradient(180deg, #0a0e1a, #070912 60%, #0a0e1a)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px)," +
            "linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(ellipse 90% 70% at 50% 30%, #000 30%, transparent 80%)",
          WebkitMaskImage: "radial-gradient(ellipse 90% 70% at 50% 30%, #000 30%, transparent 80%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 opacity-90"
        style={{
          backgroundImage: [
            "radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.7), transparent 60%)",
            "radial-gradient(1px 1px at 78% 9%, rgba(255,255,255,0.5), transparent 60%)",
            "radial-gradient(1.2px 1.2px at 42% 84%, rgba(255,255,255,0.6), transparent 60%)",
            "radial-gradient(1px 1px at 92% 62%, rgba(255,255,255,0.4), transparent 60%)",
            "radial-gradient(1px 1px at 26% 71%, rgba(255,255,255,0.45), transparent 60%)",
            "radial-gradient(1.2px 1.2px at 65% 32%, rgba(255,255,255,0.55), transparent 60%)",
            "radial-gradient(1px 1px at 6% 52%, rgba(255,255,255,0.35), transparent 60%)",
            "radial-gradient(1px 1px at 53% 12%, rgba(255,255,255,0.5), transparent 60%)",
          ].join(","),
        }}
      />

      {/* Desktop: icon rail + folder panel */}
      <aside className="relative z-10 hidden shrink-0 md:flex">
        <DesktopRails />
      </aside>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0">
          <SidebarInner onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <main className="relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-background/70 px-3 py-2 backdrop-blur md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="grid h-9 w-9 place-items-center rounded-md hover:bg-accent"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <img src={zerrowLogo} alt="Zerrow" className="h-12 w-auto" />
          <div className="ml-auto min-w-0 max-w-[60%]">
            <AccountSwitcher
              accounts={accounts}
              loading={accountsQ.isLoading}
              failed={accountsQ.isError}
              compact
            />
          </div>
        </div>
        <ReconnectBanner />
        <BackfillBanner />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** Shared data + selection plumbing for the desktop rails and the mobile
 * drawer: accounts, folders, labels, unread counts, admin flag, and the
 * `pick` handler that selects a view/folder and routes back to /inbox. */
function useSidebarData(onNavigate?: () => void) {
  const { selected, setSelected } = useFolderSelection();
  const { activeAccountId, setActiveAccountId } = useAccountSelection();

  const listAccounts = useServerFn(listMyGmailAccounts);
  const listLabelsFn = useServerFn(listGmailLabels);
  const adminMeFn = useServerFn(getAdminMe);

  const accountsQ = useQuery({ queryKey: ["gmail-accounts"], queryFn: () => listAccounts() });
  const accounts = useMemo(() => accountsQ.data?.accounts ?? [], [accountsQ.data?.accounts]);

  // Reconcile activeAccountId with the actual account list — fall back to the
  // first account if the stored selection no longer exists or none was set.
  useEffect(() => {
    if (accounts.length === 0) return;
    const exists = activeAccountId && accounts.some((a) => a.id === activeAccountId);
    if (!exists) setActiveAccountId(accounts[0].id);
  }, [accounts, activeAccountId, setActiveAccountId]);

  const accountId =
    activeAccountId && accounts.some((a) => a.id === activeAccountId)
      ? activeAccountId
      : (accounts[0]?.id ?? null);

  const adminMeQ = useQuery({
    queryKey: ["admin-me"],
    queryFn: () => adminMeFn(),
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const isAdmin = !!adminMeQ.data?.email;

  const foldersQ = useQuery({
    queryKey: ["folders-full", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data } = await supabase
        .from("folders")
        .select(FOLDER_COLUMNS)
        .eq("gmail_account_id", accountId!)
        .order("name", { ascending: true });
      return (data ?? []) as Folder[];
    },
  });

  // Reconcile the selected folder with the current account's folder list.
  // `selected` is stored globally (not per account), so after the active
  // account is auto-switched (invalid stored id, fresh load, cross-tab) a
  // folder id from the *other* account can linger — the inbox then queries a
  // folder that holds none of this account's mail and shows empty. If the
  // selection is a folder id that doesn't exist for this account (and isn't
  // one of the special views), fall back to the Inbox view.
  useEffect(() => {
    if (!accountId || !foldersQ.isSuccess) return;
    if (SPECIAL_VIEWS.includes(selected)) return;
    const folders = foldersQ.data ?? [];
    if (!folders.some((f) => f.id === selected)) setSelected("all");
  }, [accountId, foldersQ.isSuccess, foldersQ.data, selected, setSelected]);

  const labelsQ = useQuery({
    queryKey: ["gmail-labels", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      try {
        return (await listLabelsFn({ data: { account_id: accountId! } })).labels as GLabel[];
      } catch {
        return [] as GLabel[];
      }
    },
  });

  // Unread/folder counts are computed server-side by a single aggregate RPC
  // instead of downloading thousands of email rows to count in the browser.
  // Kept under its own ["folder-counts"] key (NOT ["emails"]) so routine
  // email mutations don't sweep it; realtime + a light interval keep it fresh.
  const countsQ = useQuery({
    queryKey: ["folder-counts", accountId],
    enabled: !!accountId,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data } = await supabase.rpc("get_folder_unread_counts", {
        p_account_id: accountId!,
      });
      const raw = (data ?? { byFolder: {}, no_rules: 0, total: 0 }) as {
        byFolder?: Record<string, number>;
        no_rules?: number;
        total?: number;
      };
      return {
        byFolder: raw.byFolder ?? {},
        no_rules: raw.no_rules ?? 0,
        total: raw.total ?? 0,
      };
    },
  });

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    const data = countsQ.data;
    if (!data) return { byFolder: m, total: 0 };
    for (const [folderId, n] of Object.entries(data.byFolder)) {
      if (n > 0) m.set(folderId, n);
    }
    if (data.no_rules > 0) m.set("no_rules", data.no_rules);
    return { byFolder: m, total: data.total };
  }, [countsQ.data]);

  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pick = (s: FolderSelection) => {
    setSelected(s);
    if (pathname !== "/inbox") navigate({ to: "/inbox" });
    queueMicrotask(() => onNavigate?.());
  };

  return {
    selected,
    accounts,
    accountsQ,
    accountId,
    isAdmin,
    foldersQ,
    labelsQ,
    counts,
    countsQ,
    navigate,
    pathname,
    pick,
  };
}

/** One icon in the 56px app rail. */
function RailIcon({
  label,
  active,
  onClick,
  dot = false,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  dot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`relative grid h-9 w-9 place-items-center rounded-sm transition-colors ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground"
      }`}
    >
      {children}
      {dot && (
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
      )}
    </button>
  );
}

/** A "Views" row in the folder panel (Inbox / All mail / No rules). */
function ViewRow({
  icon,
  label,
  active,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-sm border-l-2 px-2 py-1.5 text-left text-[13px] transition-colors ${
        active
          ? "border-l-primary bg-sidebar-accent text-sidebar-accent-foreground"
          : "border-l-transparent text-sidebar-foreground/80 hover:bg-sidebar-accent/60"
      }`}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {typeof count === "number" && count > 0 && (
        <span className="font-mono text-[11px] font-semibold text-primary">{count}</span>
      )}
    </button>
  );
}

/** Desktop shell chrome: 56px icon rail (app nav) + 224px contextual panel
 * (account, views, folders, sync status). Mobile keeps SidebarInner. */
function DesktopRails() {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Folder | null>(null);
  const {
    selected,
    accounts,
    accountsQ,
    accountId,
    isAdmin,
    foldersQ,
    labelsQ,
    counts,
    countsQ,
    navigate,
    pathname,
    pick,
  } = useSidebarData();

  const accountEmail = accounts.find((a) => a.id === accountId)?.email_address ?? null;
  const avatarInitial = (accountEmail ?? "?").charAt(0).toUpperCase();
  const lastSyncUtc = countsQ.dataUpdatedAt
    ? new Date(countsQ.dataUpdatedAt).toISOString().slice(11, 16)
    : null;

  const go = (to: string) => navigate({ to });

  return (
    <>
      {/* Icon rail */}
      <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-sidebar-border bg-sidebar/90 py-3 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => pick("all")}
          title="Zerrow"
          aria-label="Zerrow — Inbox"
          className="mb-3 grid h-8 w-8 place-items-center rounded-sm bg-primary font-mono text-sm font-bold text-primary-foreground"
        >
          Z
        </button>
        <RailIcon
          label="Inbox"
          active={pathname === "/inbox"}
          onClick={() => pick("all")}
          dot={counts.total > 0}
        >
          <Inbox className="h-[17px] w-[17px]" />
        </RailIcon>
        <RailIcon label="Reports" active={pathname === "/reports"} onClick={() => go("/reports")}>
          <BarChart3 className="h-[17px] w-[17px]" />
        </RailIcon>
        <RailIcon label="Tasks" active={pathname.startsWith("/tasks")} onClick={() => go("/tasks")}>
          <CheckCircle2 className="h-[17px] w-[17px]" />
        </RailIcon>
        <RailIcon
          label="Contacts"
          active={pathname.startsWith("/contacts")}
          onClick={() => go("/contacts")}
        >
          <Users className="h-[17px] w-[17px]" />
        </RailIcon>
        <RailIcon
          label="Meetings"
          active={pathname === "/meetings"}
          onClick={() => go("/meetings")}
        >
          <Video className="h-[17px] w-[17px]" />
        </RailIcon>
        <div className="flex-1" />
        {isAdmin && (
          <RailIcon label="Admin" active={pathname === "/admin"} onClick={() => go("/admin")}>
            <Shield className="h-[17px] w-[17px]" />
          </RailIcon>
        )}
        <RailIcon
          label="Settings"
          active={pathname === "/settings"}
          onClick={() => go("/settings")}
        >
          <Settings className="h-[17px] w-[17px]" />
        </RailIcon>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={accountEmail ?? "Account"}
              aria-label="Account menu"
              className="mt-1 grid h-8 w-8 place-items-center rounded-full border border-sidebar-border bg-card font-mono text-[11px] font-semibold text-amber-400"
            >
              {avatarInitial}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-60">
            <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
              {accountEmail ?? "No Gmail connected"}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await supabase.auth.signOut();
                window.location.href = "/login";
              }}
            >
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Folder panel */}
      <div className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar/70 p-3 backdrop-blur-sm">
        <div className="mb-2">
          <AccountSwitcher
            accounts={accounts}
            loading={accountsQ.isLoading}
            failed={accountsQ.isError}
          />
        </div>

        <div className="px-1.5 pb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Views
        </div>
        <ViewRow
          icon={<Inbox className="h-3.5 w-3.5" />}
          label="Inbox"
          active={selected === "all"}
          count={counts.total}
          onClick={() => pick("all")}
        />
        <ViewRow
          icon={<Layers className="h-3.5 w-3.5" />}
          label="All mail"
          active={selected === "all_mail"}
          onClick={() => pick("all_mail")}
        />
        <ViewRow
          icon={<CircleDashed className="h-3.5 w-3.5" />}
          label="No rules"
          active={selected === "no_rules"}
          count={counts.byFolder.get("no_rules") ?? 0}
          onClick={() => pick("no_rules")}
        />

        <div className="mt-3 flex items-center justify-between px-1.5 pb-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            Folders
          </span>
          <button
            onClick={() => setAddOpen(true)}
            disabled={!accountId}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground disabled:opacity-40"
            title="Add folder"
            aria-label="Add folder"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {(foldersQ.data ?? []).map((f) => (
            <FolderRow
              key={f.id}
              active={selected === f.id}
              onSelect={() => pick(f.id as FolderSelection)}
              color={f.color}
              label={f.name}
              count={counts.byFolder.get(f.id) ?? 0}
              onEdit={() => setEditing(f)}
            />
          ))}
          {accountId && (foldersQ.data ?? []).length === 0 && (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              No folders yet. Click + to add one.
            </p>
          )}
          {!accountId && !accountsQ.isLoading && (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              Connect Gmail in{" "}
              <button type="button" className="underline" onClick={() => go("/settings")}>
                Settings
              </button>
              .
            </p>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2 border-t border-sidebar-border pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" aria-hidden />
          {lastSyncUtc ? `Synced · ${lastSyncUtc} UTC` : "Syncing…"}
        </div>

        <AddFolderDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          accountId={accountId}
          labels={labelsQ.data ?? []}
        />
        <EditFolderDialog
          folder={editing}
          labels={labelsQ.data ?? []}
          open={!!editing}
          onOpenChange={(v) => {
            if (!v) setEditing(null);
          }}
        />
      </div>
    </>
  );
}

function SidebarInner({ onNavigate }: { onNavigate?: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Folder | null>(null);
  const {
    selected,
    accounts,
    accountsQ,
    accountId,
    isAdmin,
    foldersQ,
    labelsQ,
    counts,
    pathname,
    navigate,
    pick,
  } = useSidebarData(onNavigate);

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-4 px-2">
        <div className="flex items-center gap-2">
          <img src={zerrowLogo} alt="Zerrow" className="h-14 w-auto" />
        </div>
      </div>

      <div className="mb-4 px-1">
        <AccountSwitcher
          accounts={accounts}
          loading={accountsQ.isLoading}
          failed={accountsQ.isError}
          onNavigate={onNavigate}
        />
      </div>

      <nav className="flex flex-col gap-0.5">
        <button
          type="button"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60"
          onClick={() => pick("all")}
        >
          <Inbox className="h-4 w-4" /> Inbox
        </button>
        <button
          type="button"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 ${pathname === "/reports" ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
          onClick={() => {
            navigate({ to: "/reports" });
            onNavigate?.();
          }}
        >
          <BarChart3 className="h-4 w-4" /> Reports
        </button>
        <button
          type="button"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 ${pathname.startsWith("/tasks") ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
          onClick={() => {
            navigate({ to: "/tasks" });
            onNavigate?.();
          }}
        >
          <CheckCircle2 className="h-4 w-4" /> Tasks
        </button>
        <button
          type="button"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 ${pathname.startsWith("/contacts") ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
          onClick={() => {
            navigate({ to: "/contacts" });
            onNavigate?.();
          }}
        >
          <Users className="h-4 w-4" /> Contacts
        </button>
        <button
          type="button"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 ${pathname === "/meetings" ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
          onClick={() => {
            navigate({ to: "/meetings" });
            onNavigate?.();
          }}
        >
          <Video className="h-4 w-4" /> Meetings
        </button>
        <button
          type="button"
          className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 ${pathname === "/settings" ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
          onClick={() => {
            navigate({ to: "/settings" });
            onNavigate?.();
          }}
        >
          <Settings className="h-4 w-4" /> Settings
        </button>
        {isAdmin && (
          <button
            type="button"
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent/60 ${pathname === "/admin" ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
            onClick={() => {
              navigate({ to: "/admin" });
              onNavigate?.();
            }}
          >
            <Shield className="h-4 w-4" /> Admin
          </button>
        )}
      </nav>

      <div className="mt-6 flex items-center justify-between px-2">
        <span className="text-[11px] uppercase tracking-widest text-muted-foreground">Folders</span>
        <button
          onClick={() => setAddOpen(true)}
          disabled={!accountId}
          className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground disabled:opacity-40"
          title="Add folder"
          aria-label="Add folder"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 flex flex-1 flex-col gap-0.5 overflow-y-auto">
        <FolderRow
          active={selected === "all_mail"}
          onSelect={() => pick("all_mail")}
          color="#d4d4d8"
          label="All mail"
        />
        <FolderRow
          active={selected === "no_rules"}
          onSelect={() => pick("no_rules")}
          color="#71717a"
          label="No rules"
        />

        {(foldersQ.data ?? []).map((f) => (
          <FolderRow
            key={f.id}
            active={selected === f.id}
            onSelect={() => pick(f.id as FolderSelection)}
            color={f.color}
            label={f.name}
            count={counts.byFolder.get(f.id) ?? 0}
            onEdit={() => setEditing(f)}
          />
        ))}

        {accountId && (foldersQ.data ?? []).length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No folders yet. Click + to add one.
          </p>
        )}
        {!accountId && !accountsQ.isLoading && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            Connect Gmail in{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                navigate({ to: "/settings" });
                onNavigate?.();
              }}
            >
              Settings
            </button>
            .
          </p>
        )}
      </div>

      <div className="mt-4">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-sidebar-foreground"
          onClick={async () => {
            await supabase.auth.signOut();
            window.location.href = "/login";
          }}
        >
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </Button>
      </div>

      <AddFolderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        accountId={accountId}
        labels={labelsQ.data ?? []}
      />
      <EditFolderDialog
        folder={editing}
        labels={labelsQ.data ?? []}
        open={!!editing}
        onOpenChange={(v) => {
          if (!v) setEditing(null);
        }}
      />
    </div>
  );
}

function FolderRow({
  active,
  onSelect,
  color,
  label,
  count,
  onEdit,
}: {
  active: boolean;
  onSelect: () => void;
  color: string;
  label: string;
  count?: number;
  onEdit?: () => void;
}) {
  return (
    <div
      className={`group flex items-center rounded-sm border-l-2 text-[13px] transition-colors ${
        active
          ? "border-l-primary bg-sidebar-accent text-sidebar-accent-foreground"
          : "border-l-transparent text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      }`}
    >
      <button
        onClick={onSelect}
        className="flex flex-1 items-center gap-2 truncate px-2 py-1.5 text-left"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="flex-1 truncate">{label}</span>
        {typeof count === "number" && count > 0 && (
          <span className="rounded-full bg-primary/15 px-1.5 font-mono text-[10px] font-semibold text-primary">
            {count}
          </span>
        )}
      </button>
      {onEdit && (
        <button
          className="mr-1 grid h-6 w-6 place-items-center rounded text-muted-foreground opacity-100 transition-opacity hover:bg-background/50 hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          aria-label={`Edit ${label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
