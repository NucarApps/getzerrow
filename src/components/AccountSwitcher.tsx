import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Mail, ChevronDown, Check, Plus, AlertTriangle } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccountSelection } from "@/lib/account-selection";
import { useFolderSelection } from "@/lib/folder-selection";
import { startConnectGmail } from "@/lib/gmail.functions";

export type SwitcherAccount = {
  id: string;
  email_address: string;
  needs_reauth?: boolean;
};

type Props = {
  accounts: SwitcherAccount[];
  loading?: boolean;
  compact?: boolean;
  onNavigate?: () => void;
};

export function AccountSwitcher({ accounts, loading, compact, onNavigate }: Props) {
  const { activeAccountId, setActiveAccountId } = useAccountSelection();
  const { setSelected } = useFolderSelection();
  const navigate = useNavigate();
  const connect = useServerFn(startConnectGmail);
  const [connecting, setConnecting] = useState(false);

  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0] ?? null;

  const goSettings = () => {
    navigate({ to: "/settings" });
    onNavigate?.();
  };

  const addAccount = async () => {
    if (connecting) return;
    setConnecting(true);
    try {
      const { url } = await connect({ data: {} });
      window.location.href = url;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Couldn't start Google sign-in";
      toast.error(msg);
      setConnecting(false);
      goSettings();
    }
  };

  if (!loading && accounts.length === 0) {
    return (
      <button
        type="button"
        onClick={addAccount}
        className={`flex w-full items-center gap-2 rounded-md border border-dashed border-sidebar-border bg-sidebar-accent/30 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-sidebar-accent/60 ${compact ? "h-9" : ""}`}
      >
        <Plus className="h-4 w-4 shrink-0" />
        <span className="truncate">Connect a Gmail account</span>
      </button>
    );
  }

  const label = active?.email_address ?? (loading ? "Loading…" : "No account");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-3 py-2 text-left text-xs text-sidebar-foreground hover:bg-sidebar-accent/70 ${compact ? "h-9 max-w-[220px]" : ""}`}
          title={label}
        >
          <Mail className="h-4 w-4 shrink-0 text-primary" />
          <span className="flex-1 truncate font-medium">{label}</span>
          {active?.needs_reauth && (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {accounts.map((a) => {
          const isActive = a.id === (active?.id ?? null);
          return (
            <DropdownMenuItem
              key={a.id}
              onSelect={() => {
                if (!isActive) {
                  setActiveAccountId(a.id);
                  // Folder lists are scoped per account — reset so the user
                  // doesn't land on a folder from the other account.
                  setSelected("all");
                }
                onNavigate?.();
              }}
              className="flex items-center gap-2"
            >
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="flex-1 truncate text-sm">{a.email_address}</span>
              {a.needs_reauth && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
              {isActive && <Check className="h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            addAccount();
          }}
          className="flex items-center gap-2"
          disabled={connecting}
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="text-sm">{connecting ? "Redirecting…" : "Connect another Gmail"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={goSettings} className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Manage accounts</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
