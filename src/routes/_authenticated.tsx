import { createFileRoute, redirect, Outlet, Link, useLocation } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Inbox, FolderTree, Settings, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) throw redirect({ to: "/login" });
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  const loc = useLocation();
  const items = [
    { to: "/", icon: Inbox, label: "Inbox" },
    { to: "/folders", icon: FolderTree, label: "Folders" },
    { to: "/settings", icon: Settings, label: "Settings" },
  ];
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar p-4">
        <div className="mb-8 px-2">
          <h1 className="font-display text-3xl tracking-tight text-foreground">Zerrow</h1>
          <p className="text-[11px] uppercase tracking-widest text-muted-foreground">AI inbox</p>
        </div>
        <nav className="flex flex-col gap-1">
          {items.map((it) => {
            const active = loc.pathname === it.to;
            return (
              <Link
                key={it.to}
                to={it.to}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60"}`}
              >
                <it.icon className="h-4 w-4" />{it.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-sidebar-foreground"
            onClick={async () => { await supabase.auth.signOut(); window.location.href = "/login"; }}
          >
            <LogOut className="mr-2 h-4 w-4" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
