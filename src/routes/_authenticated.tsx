import { createFileRoute, redirect, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listGmailLabels, listMyGmailAccounts } from "@/lib/gmail.functions";
import { Inbox, Settings, LogOut, Plus, Pencil, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { FolderSelectionProvider, useFolderSelection, type FolderSelection } from "@/lib/folder-selection";
import { AddFolderDialog } from "@/components/folders/AddFolderDialog";
import { EditFolderDialog } from "@/components/folders/EditFolderDialog";
import type { Folder, GLabel } from "@/components/folders/FolderEditor";
import { useEmailRealtime } from "@/lib/use-email-realtime";
import zerrowLogo from "@/assets/zerrow-logo-v2.png";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw redirect({ to: "/login" });
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  useEmailRealtime();

  return (
    <FolderSelectionProvider>
      <div className="relative flex h-screen overflow-hidden bg-background text-foreground">
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
            maskImage:
              "radial-gradient(ellipse 90% 70% at 50% 30%, #000 30%, transparent 80%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 90% 70% at 50% 30%, #000 30%, transparent 80%)",
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

        {/* Desktop sidebar */}
        <aside className="relative z-10 hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar/80 backdrop-blur-sm md:flex md:flex-col">
          <SidebarInner />
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
          </div>
          <div className="min-h-0 flex-1">
            <Outlet />
          </div>
        </main>
      </div>
    </FolderSelectionProvider>
  );
}

function SidebarInner({ onNavigate }: { onNavigate?: () => void }) {
  
  const { selected, setSelected } = useFolderSelection();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Folder | null>(null);

  const listAccounts = useServerFn(listMyGmailAccounts);
  const listLabelsFn = useServerFn(listGmailLabels);

  const accountsQ = useQuery({ queryKey: ["gmail-accounts"], queryFn: () => listAccounts() });
  const accountId = accountsQ.data?.accounts[0]?.id ?? null;

  const foldersQ = useQuery({
    queryKey: ["folders-full", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data } = await supabase.from("folders").select("*").eq("gmail_account_id", accountId!).order("name", { ascending: true });
      return (data ?? []) as Folder[];
    },
  });

  const labelsQ = useQuery({
    queryKey: ["gmail-labels", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      try { return (await listLabelsFn({ data: { account_id: accountId! } })).labels as GLabel[]; } catch { return [] as GLabel[]; }
    },
  });

  const emailsQ = useQuery({
    queryKey: ["emails", "counts"],
    queryFn: async () => {
      const { data } = await supabase
        .from("emails")
        .select("id,folder_id,is_read,is_archived,raw_labels")
        .limit(5000);
      return (data ?? []) as Array<{ id: string; folder_id: string | null; is_read: boolean; is_archived: boolean; raw_labels: string[] | null }>;
    },
  });


  const counts = useMemo(() => {
    const m = new Map<string, number>();
    let total = 0;
    for (const e of emailsQ.data ?? []) {
      if (e.folder_id) {
        if (!e.is_read) m.set(e.folder_id, (m.get(e.folder_id) ?? 0) + 1);
        if (!e.is_read && !e.is_archived) total++;
      } else {
        if (!e.is_read && !e.is_archived) total++;
        const hasUserLabel = e.raw_labels?.some((l) => l.startsWith("Label_")) ?? false;
        if (!hasUserLabel) m.set("no_rules", (m.get("no_rules") ?? 0) + 1);
      }
    }
    return { byFolder: m, total };
  }, [emailsQ.data]);

  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pick = (s: FolderSelection) => {
    setSelected(s);
    if (pathname !== "/inbox") navigate({ to: "/inbox" });
    onNavigate?.();
  };

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-6 px-2">
        <div className="flex items-center gap-2">
          <img src={zerrowLogo} alt="Zerrow" className="h-14 w-auto" />
        </div>
        <p className="text-[11px] uppercase tracking-widest text-muted-foreground">AI inbox</p>
      </div>

      <nav className="flex flex-col gap-0.5">
        <Link
          to="/inbox"
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent/60"
          onClick={() => pick("all")}
        >
          <Inbox className="h-4 w-4" /> Inbox
        </Link>
        <Link
          to="/settings"
          activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent/60"
          onClick={() => onNavigate?.()}
        >
          <Settings className="h-4 w-4" /> Settings
        </Link>
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
          active={selected === "all"}
          onSelect={() => pick("all")}
          color="#a3a3a3"
          label="All inbox"
          count={counts.total}
        />
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
            Connect Gmail in <Link to="/settings" className="underline" onClick={() => onNavigate?.()}>Settings</Link>.
          </p>
        )}
      </div>

      <div className="mt-4">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-sidebar-foreground"
          onClick={async () => { await supabase.auth.signOut(); window.location.href = "/login"; }}
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
        onOpenChange={(v) => { if (!v) setEditing(null); }}
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
      className={`group flex items-center rounded-md text-sm transition-colors ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60"}`}
    >
      <button
        onClick={onSelect}
        className="flex flex-1 items-center gap-2 truncate px-3 py-1.5 text-left"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="flex-1 truncate">{label}</span>
        {typeof count === "number" && count > 0 && (
          <span className="rounded-full bg-primary/20 px-1.5 text-[10px] text-primary">{count}</span>
        )}
      </button>
      {onEdit && (
        <button
          className="mr-1 grid h-6 w-6 place-items-center rounded text-muted-foreground opacity-100 transition-opacity hover:bg-background/50 hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          aria-label={`Edit ${label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
