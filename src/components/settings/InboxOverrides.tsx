import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, ShieldOff, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";

type Override = {
  id: string;
  match_type: "email" | "domain";
  value: string;
  note: string | null;
  created_at: string;
};

type Exception = {
  id: string;
  override_id: string;
  field: string;
  op: string;
  value: string;
};

const FIELD_OPTS: Array<{ value: string; label: string }> = [
  { value: "from", label: "From" },
  { value: "to", label: "To" },
  { value: "subject", label: "Subject" },
  { value: "body", label: "Body" },
  { value: "cc", label: "Cc" },
  { value: "list_id", label: "List-Id" },
  { value: "domain", label: "From domain" },
];

const OP_OPTS: Array<{ value: string; label: string }> = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "not_equals", label: "doesn't equal" },
  { value: "regex", label: "matches regex" },
];

export function InboxOverrides({
  accountId,
  accountEmail,
}: {
  accountId: string | null;
  accountEmail: string | null;
}) {
  const qc = useQueryClient();
  const [matchType, setMatchType] = useState<"email" | "domain">("email");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<"all" | "email" | "domain">("all");
  const [search, setSearch] = useState("");

  const q = useQuery({
    queryKey: ["inbox-overrides", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inbox_overrides")
        .select("*")
        .eq("gmail_account_id", accountId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Override[];
    },
  });

  const ex = useQuery({
    queryKey: ["inbox-override-exceptions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("inbox_override_exceptions")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Exception[];
    },
  });

  async function add() {
    const v = value.trim().toLowerCase();
    if (!v) return;
    if (!accountId) {
      toast.error("Pick a Gmail account first");
      return;
    }
    if (matchType === "email" && !v.includes("@")) {
      toast.error("Enter a full email address");
      return;
    }
    if (matchType === "domain" && v.includes("@")) {
      toast.error("Enter a domain only (e.g. example.com)");
      return;
    }
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setBusy(false);
      toast.error("Not signed in");
      return;
    }
    const { error } = await supabase
      .from("inbox_overrides")
      .insert({ user_id: u.user.id, gmail_account_id: accountId, match_type: matchType, value: v });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setValue("");
    toast.success(`Added ${v} to your inbox list`);
    qc.invalidateQueries({ queryKey: ["inbox-overrides", accountId] });
  }

  async function remove(id: string) {
    const { error } = await supabase.from("inbox_overrides").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["inbox-overrides", accountId] });
    qc.invalidateQueries({ queryKey: ["inbox-override-exceptions"] });
  }

  const rows = q.data ?? [];
  const exceptions = ex.data ?? [];
  const emailCount = rows.filter((r) => r.match_type === "email").length;
  const domainCount = rows.filter((r) => r.match_type === "domain").length;
  const searchLower = search.trim().toLowerCase();
  const filteredRows = rows.filter((r) => {
    if (filter !== "all" && r.match_type !== filter) return false;
    if (searchLower && !r.value.toLowerCase().includes(searchLower)) return false;
    return true;
  });

  return (
    <Card className="p-4 md:p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <ShieldOff className="h-4 w-4 text-destructive" />
          <h2 className="font-display text-2xl">Always send to inbox</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Senders on this list skip folder rules and AI sorting for
          {accountEmail ? (
            <>
              {" "}
              <span className="font-medium text-foreground">{accountEmail}</span>
            </>
          ) : (
            " this inbox"
          )}
          . Add exceptions to let specific emails (e.g. subject starts with "RE: Daily Reports") be
          sorted normally.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Select value={matchType} onValueChange={(v) => setMatchType(v as "email" | "domain")}>
          <SelectTrigger className="sm:w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email">Email address</SelectItem>
            <SelectItem value="domain">Domain</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="flex-1"
          placeholder={matchType === "email" ? "ceo@chevrolet.com" : "chevrolet.com"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <Button onClick={add} disabled={busy}>
          {busy ? "Adding…" : "Add"}
        </Button>
      </div>

      {rows.length > 0 && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "email" | "domain")}>
            <TabsList className="bg-card border border-border rounded-md p-0.5 h-auto gap-0.5">
              <TabsTrigger
                value="all"
                className="px-3 py-1.5 text-xs text-foreground/70 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
              >
                All ({rows.length})
              </TabsTrigger>
              <TabsTrigger
                value="email"
                className="px-3 py-1.5 text-xs text-foreground/70 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
              >
                Emails ({emailCount})
              </TabsTrigger>
              <TabsTrigger
                value="domain"
                className="px-3 py-1.5 text-xs text-foreground/70 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none"
              >
                Domains ({domainCount})
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative sm:w-64">
            <Input
              className="h-8 pr-8 text-xs"
              placeholder="Search overrides…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {rows.length === 0 && (
          <p className="text-sm italic text-muted-foreground">No overrides yet.</p>
        )}
        {rows.length > 0 && filteredRows.length === 0 && (
          <p className="text-sm italic text-muted-foreground">
            No {filter === "all" ? "" : filter === "email" ? "email " : "domain "}overrides match.
          </p>
        )}
        {filteredRows.map((r) => {
          const isOpen = !!expanded[r.id];
          const rowEx = exceptions.filter((e) => e.override_id === r.id);
          return (
            <div key={r.id} className="rounded-md border border-destructive/30 bg-destructive/5">
              <div className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <button
                  className="flex shrink-0 items-center text-muted-foreground hover:text-foreground"
                  onClick={() => setExpanded((s) => ({ ...s, [r.id]: !isOpen }))}
                  aria-label={isOpen ? "Collapse exceptions" : "Expand exceptions"}
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
                <span className="shrink-0 rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive">
                  {r.match_type}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.value}</span>
                {rowEx.length > 0 && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {rowEx.length} exception{rowEx.length === 1 ? "" : "s"}
                  </span>
                )}
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 shrink-0"
                  onClick={() => remove(r.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              {isOpen && (
                <ExceptionEditor
                  override={r}
                  exceptions={rowEx}
                  onChanged={() =>
                    qc.invalidateQueries({ queryKey: ["inbox-override-exceptions"] })
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ExceptionEditor({
  override,
  exceptions,
  onChanged,
}: {
  override: Override;
  exceptions: Exception[];
  onChanged: () => void;
}) {
  const [field, setField] = useState("subject");
  const [op, setOp] = useState("starts_with");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    const v = value.trim();
    if (!v) return;
    setBusy(true);
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setBusy(false);
      toast.error("Not signed in");
      return;
    }
    const { error } = await supabase.from("inbox_override_exceptions").insert({
      override_id: override.id,
      user_id: u.user.id,
      field,
      op,
      value: v,
    });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setValue("");
    onChanged();
  }

  async function remove(id: string) {
    const { error } = await supabase.from("inbox_override_exceptions").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    onChanged();
  }

  return (
    <div className="border-t border-destructive/20 bg-background/40 px-3 py-2.5">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Emails from <span className="font-mono">{override.value}</span> that match any exception
        below will be sorted normally instead of forced to the inbox.
      </p>
      <div className="space-y-1.5">
        {exceptions.length === 0 && (
          <p className="text-xs italic text-muted-foreground">
            No exceptions — every email from {override.value} goes to inbox.
          </p>
        )}
        {exceptions.map((e) => (
          <div
            key={e.id}
            className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs"
          >
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-medium">
              {FIELD_OPTS.find((f) => f.value === e.field)?.label ?? e.field}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {OP_OPTS.find((o) => o.value === e.op)?.label ?? e.op}
            </span>
            <span className="min-w-0 flex-1 truncate break-all font-mono">{e.value}</span>
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5 shrink-0"
              onClick={() => remove(e.id)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row sm:items-center">
        <Select value={field} onValueChange={setField}>
          <SelectTrigger className="h-8 text-xs sm:w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELD_OPTS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={op} onValueChange={setOp}>
          <SelectTrigger className="h-8 text-xs sm:w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OP_OPTS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="h-8 min-w-0 flex-1 text-xs"
          placeholder={op === "regex" ? "^RE: Daily Reports" : "RE: Daily Reports"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <Button size="sm" onClick={add} disabled={busy} className="shrink-0">
          <Plus className="mr-1 h-3 w-3" /> Add
        </Button>
      </div>
    </div>
  );
}
