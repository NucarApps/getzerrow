import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Users, ScanLine, Search, IdCard, RefreshCw, Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { listContacts, backfillContacts } from "@/lib/contacts.functions";
import {
  listContactGroups, createContactGroup, updateContactGroup, deleteContactGroup,
} from "@/lib/contact-groups.functions";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/contacts")({
  head: () => ({
    meta: [
      { title: "Contacts — Zerrow" },
      { name: "description", content: "People you've emailed with, enriched from signatures." },
    ],
  }),
  component: ContactsPage,
});

const GROUP_COLORS = [
  "#6366f1", "#ef4444", "#f59e0b", "#10b981", "#06b6d4", "#8b5cf6", "#ec4899", "#64748b",
];

type GroupRow = { id: string; name: string; color: string; count: number };

function ContactsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useServerFn(listContacts);
  const build = useServerFn(backfillContacts);
  const listGroups = useServerFn(listContactGroups);

  const [query, setQuery] = useState("");
  const [building, setBuilding] = useState(false);
  const [filter, setFilter] = useState<"all" | "ungrouped" | string>("all");
  const [groupDialog, setGroupDialog] = useState<null | { mode: "create" } | { mode: "edit"; group: GroupRow }>(null);

  const q = useQuery({ queryKey: ["contacts"], queryFn: () => list() });
  const gq = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });

  useEffect(() => {
    if (q.data && q.data.contacts.length === 0 && !building) {
      setBuilding(true);
      build()
        .then((r) => {
          if (r.added > 0) toast.success(`Built ${r.added} contacts from your inbox`);
          qc.invalidateQueries({ queryKey: ["contacts"] });
        })
        .catch((e) => toast.error(e?.message ?? "Failed to build contacts"))
        .finally(() => setBuilding(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.contacts.length]);

  // contact_id -> [group ids]
  const contactGroupMap = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const x of gq.data?.memberships ?? []) {
      const arr = m.get(x.contact_id) ?? [];
      arr.push(x.group_id);
      m.set(x.contact_id, arr);
    }
    return m;
  }, [gq.data]);

  const groupsById = useMemo(() => {
    const m = new Map<string, GroupRow>();
    for (const g of gq.data?.groups ?? []) m.set(g.id, g);
    return m;
  }, [gq.data]);

  const filtered = useMemo(() => {
    const all = q.data?.contacts ?? [];
    const t = query.toLowerCase().trim();
    return all.filter((x) => {
      if (filter === "ungrouped" && (contactGroupMap.get(x.id)?.length ?? 0) > 0) return false;
      if (filter !== "all" && filter !== "ungrouped") {
        if (!(contactGroupMap.get(x.id) ?? []).includes(filter)) return false;
      }
      if (!t) return true;
      return (
        (x.name ?? "").toLowerCase().includes(t) ||
        x.email.toLowerCase().includes(t) ||
        (x.company ?? "").toLowerCase().includes(t)
      );
    });
  }, [q.data, query, filter, contactGroupMap]);

  async function rebuild() {
    setBuilding(true);
    try {
      const r = await build();
      toast.success(`Added ${r.added} new contacts`);
      qc.invalidateQueries({ queryKey: ["contacts"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally {
      setBuilding(false);
    }
  }

  const ungroupedCount = useMemo(() => {
    const all = q.data?.contacts ?? [];
    let n = 0;
    for (const c of all) if ((contactGroupMap.get(c.id)?.length ?? 0) === 0) n++;
    return n;
  }, [q.data, contactGroupMap]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-primary/10 text-primary">
            <Users className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-[200px]">
            <h1 className="font-display text-2xl text-foreground">Contacts</h1>
            <p className="text-xs text-muted-foreground">
              {q.data ? `${q.data.contacts.length} people` : "Loading…"}
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/my-card"><IdCard className="mr-2 h-4 w-4" /> My card</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link to="/contacts/scan"><ScanLine className="mr-2 h-4 w-4" /> Scan card</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={rebuild} disabled={building}>
            <RefreshCw className={`mr-2 h-4 w-4 ${building ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </header>

        <div className="grid gap-6 md:grid-cols-[220px_1fr]">
          {/* Groups rail */}
          <aside className="md:sticky md:top-2 md:self-start">
            <div className="mb-2 flex items-center justify-between px-2">
              <span className="text-[11px] uppercase tracking-widest text-muted-foreground">Groups</span>
              <button
                onClick={() => setGroupDialog({ mode: "create" })}
                className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                title="New group"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-col gap-0.5">
              <GroupChip
                active={filter === "all"}
                color="#a3a3a3"
                label="All contacts"
                count={q.data?.contacts.length ?? 0}
                onClick={() => setFilter("all")}
              />
              <GroupChip
                active={filter === "ungrouped"}
                color="#71717a"
                label="Ungrouped"
                count={ungroupedCount}
                onClick={() => setFilter("ungrouped")}
              />
              {(gq.data?.groups ?? []).map((g) => (
                <GroupChip
                  key={g.id}
                  active={filter === g.id}
                  color={g.color}
                  label={g.name}
                  count={g.count}
                  onClick={() => setFilter(g.id)}
                  onEdit={() => setGroupDialog({ mode: "edit", group: g })}
                />
              ))}
              {(gq.data?.groups ?? []).length === 0 && (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  No groups yet. Click + to add one like “Work” or “Personal”.
                </p>
              )}
            </div>
          </aside>

          {/* Main list */}
          <div>
            <div className="mb-4 relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by name, email, or company…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            {q.isLoading || building ? (
              <div className="grid gap-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded-md border border-border bg-card/40" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {query ? "No matches." : "No contacts in this view yet."}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
                {filtered.map((c) => {
                  const gids = contactGroupMap.get(c.id) ?? [];
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => navigate({ to: "/contacts/$id", params: { id: c.id } })}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40"
                      >
                        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                          {(c.name || c.email).slice(0, 1).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-foreground">{c.name || c.email}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {c.company ? `${c.company} · ` : ""}{c.email}
                          </div>
                        </div>
                        {gids.length > 0 && (
                          <div className="flex items-center gap-1">
                            {gids.slice(0, 4).map((gid) => {
                              const g = groupsById.get(gid);
                              if (!g) return null;
                              return (
                                <span
                                  key={gid}
                                  className="h-2 w-2 rounded-full"
                                  style={{ background: g.color }}
                                  title={g.name}
                                />
                              );
                            })}
                          </div>
                        )}
                        {c.source === "scan" && (
                          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-400">
                            scanned
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      <GroupEditorDialog
        state={groupDialog}
        onClose={() => setGroupDialog(null)}
        onChanged={() => qc.invalidateQueries({ queryKey: ["contact-groups"] })}
      />
    </div>
  );
}

function GroupChip({
  active, color, label, count, onClick, onEdit,
}: {
  active: boolean; color: string; label: string; count?: number;
  onClick: () => void; onEdit?: () => void;
}) {
  return (
    <div
      className={`group flex items-center rounded-md text-sm ${active ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/40"}`}
    >
      <button onClick={onClick} className="flex flex-1 items-center gap-2 truncate px-3 py-1.5 text-left">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="flex-1 truncate">{label}</span>
        {typeof count === "number" && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{count}</span>
        )}
      </button>
      {onEdit && (
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="mr-1 grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-background/50 hover:text-foreground md:opacity-0 md:group-hover:opacity-100"
          aria-label={`Edit ${label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function GroupEditorDialog({
  state, onClose, onChanged,
}: {
  state: null | { mode: "create" } | { mode: "edit"; group: GroupRow };
  onClose: () => void;
  onChanged: () => void;
}) {
  const create = useServerFn(createContactGroup);
  const update = useServerFn(updateContactGroup);
  const del = useServerFn(deleteContactGroup);

  const [name, setName] = useState("");
  const [color, setColor] = useState(GROUP_COLORS[0]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!state) return;
    if (state.mode === "edit") { setName(state.group.name); setColor(state.group.color); }
    else { setName(""); setColor(GROUP_COLORS[0]); }
  }, [state]);

  if (!state) return null;
  const editing = state.mode === "edit";

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editing && state.mode === "edit") {
        await update({ data: { id: state.group.id, name: name.trim(), color } });
        toast.success("Group updated");
      } else {
        await create({ data: { name: name.trim(), color } });
        toast.success("Group created");
      }
      onChanged();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (state.mode !== "edit") return;
    if (!confirm(`Delete the “${state.group.name}” group? Contacts won't be deleted.`)) return;
    setSaving(true);
    try {
      await del({ data: { id: state.group.id } });
      toast.success("Group deleted");
      onChanged();
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit group" : "New group"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, Personal, Investors…" autoFocus />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Color</Label>
            <div className="mt-1 flex flex-wrap gap-2">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-background transition ${color === c ? "ring-foreground" : "ring-transparent"}`}
                  style={{ background: c }}
                  aria-label={c}
                />
              ))}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          {editing && (
            <Button variant="ghost" className="text-destructive mr-auto" onClick={remove} disabled={saving}>
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || !name.trim()}>{saving ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
