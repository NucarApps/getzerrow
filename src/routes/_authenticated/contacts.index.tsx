import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { Users, ScanLine, Search, IdCard, Plus, Pencil, Trash2, UserPlus, Inbox, Check, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listContacts, createContactManual, listFoldersForPicker,
  listUniqueInboxSenders, bulkCreateContactsFromEmails,
} from "@/lib/contacts.functions";
import {
  listContactGroups, createContactGroup, updateContactGroup, deleteContactGroup,
} from "@/lib/contact-groups.functions";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { CompanyLogo } from "@/components/contacts/CompanyLogo";
import { CompanyBucketHeader } from "@/components/contacts/CompanyBucketHeader";
import { CompanyAliasesDialog } from "@/components/contacts/CompanyAliasesDialog";
import { extractDomain, isPersonalDomain, prettyCompanyName, contactLogoDomain, resolveCompanyDomain } from "@/lib/company-domains";
import { ContactDrawer } from "@/components/contacts/ContactDrawer";
import { listCompanyAliases } from "@/lib/company-aliases.functions";
import { listCompanyLogoChoices } from "@/lib/company-logo.functions";


export const Route = createFileRoute("/_authenticated/contacts/")({
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
  const list = useServerFn(listContacts);
  const listGroups = useServerFn(listContactGroups);
  const listAliases = useServerFn(listCompanyAliases);
  const listLogoChoices = useServerFn(listCompanyLogoChoices);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "ungrouped" | string>("all");
  const [groupDialog, setGroupDialog] = useState<null | { mode: "create" } | { mode: "edit"; group: GroupRow }>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [groupByCompany, setGroupByCompany] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [aliasDialog, setAliasDialog] = useState<null | { domain: string; name: string }>(null);


  const q = useQuery({ queryKey: ["contacts"], queryFn: () => list() });
  const gq = useQuery({ queryKey: ["contact-groups"], queryFn: () => listGroups() });
  const aq = useQuery({ queryKey: ["company-aliases"], queryFn: () => listAliases() });
  const lq = useQuery({ queryKey: ["company-logo-choices"], queryFn: () => listLogoChoices() });

  const logoProviderByDomain = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of lq.data ?? []) m.set(r.domain, r.provider);
    return m;
  }, [lq.data]);

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


  const ungroupedCount = useMemo(() => {
    const all = q.data?.contacts ?? [];
    let n = 0;
    for (const c of all) if ((contactGroupMap.get(c.id)?.length ?? 0) === 0) n++;
    return n;
  }, [q.data, contactGroupMap]);

  type Contact = (typeof filtered)[number];
  type Bucket = { key: string; domain: string | null; name: string; kind: "company" | "personal" | "other"; contacts: Contact[] };

  const aliasMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of aq.data ?? []) m.set(r.alias_domain, r.primary_domain);
    return m;
  }, [aq.data]);

  const aliasesByPrimary = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of aq.data ?? []) {
      const arr = m.get(r.primary_domain) ?? [];
      arr.push(r.alias_domain);
      m.set(r.primary_domain, arr);
    }
    return m;
  }, [aq.data]);

  const companyBuckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, Bucket>();
    const PERSONAL_KEY = "__personal__";
    const OTHER_KEY = "__other__";
    for (const c of filtered) {
      const rawDomain = extractDomain(c.email);
      const d = resolveCompanyDomain(rawDomain, aliasMap);
      const webDomain = contactLogoDomain((c as any).website, c.email);
      const resolvedWeb = resolveCompanyDomain(webDomain, aliasMap);
      let key: string;
      let bucket: Bucket | undefined;
      if (!d) {
        key = OTHER_KEY;
        bucket = map.get(key) ?? { key, domain: null, name: "Other", kind: "other", contacts: [] };
      } else if (isPersonalDomain(d)) {
        key = PERSONAL_KEY;
        bucket = map.get(key) ?? { key, domain: null, name: "Personal email", kind: "personal", contacts: [] };
      } else {
        key = d;
        bucket = map.get(key) ?? { key, domain: resolvedWeb ?? d, name: prettyCompanyName(d), kind: "company", contacts: [] };
        if (c.company && bucket.name === prettyCompanyName(d)) bucket.name = c.company;
        if (resolvedWeb && bucket.domain === d) bucket.domain = resolvedWeb;
      }
      bucket.contacts.push(c);
      map.set(key, bucket);
    }
    const arr = Array.from(map.values());
    const companies = arr.filter((b) => b.kind === "company")
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const personal = arr.filter((b) => b.kind === "personal");
    const other = arr.filter((b) => b.kind === "other");
    return [...companies, ...personal, ...other];
  }, [filtered, aliasMap]);

  function toggleBucket(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  // Auto-collapse all buckets when toggling "By company" on, and again the
  // first time buckets become available (initial load races contacts query).
  const initialCollapseDoneRef = useRef(false);
  useEffect(() => {
    if (groupByCompany) {
      setCollapsed(new Set(companyBuckets.map((b) => b.key)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupByCompany]);
  useEffect(() => {
    if (!initialCollapseDoneRef.current && groupByCompany && companyBuckets.length > 0) {
      initialCollapseDoneRef.current = true;
      setCollapsed(new Set(companyBuckets.map((b) => b.key)));
    }
  }, [companyBuckets, groupByCompany]);


  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <header className="mb-6 flex items-center gap-2 sm:gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
            <Users className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-display text-xl sm:text-2xl text-foreground">Contacts</h1>
            <p className="text-xs text-muted-foreground">
              {q.data ? `${q.data.contacts.length} people` : "Loading…"}
            </p>
          </div>
          <Button variant="outline" size="sm" asChild className="px-2 sm:px-3">
            <Link to="/my-card" aria-label="My card" title="My card">
              <IdCard className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">My card</span>
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild className="px-2 sm:px-3">
            <Link to="/contacts/scan" aria-label="Scan card" title="Scan card">
              <ScanLine className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">Scan card</span>
            </Link>
          </Button>
          <Button size="sm" onClick={() => setAddOpen(true)} className="px-2 sm:px-3" aria-label="Add contact" title="Add contact">
            <Plus className="h-4 w-4 sm:mr-2" /><span className="hidden sm:inline">Add</span>
          </Button>
        </header>


        {/* Mobile groups: horizontal pill scroller */}
        <div className="mb-4 -mx-4 px-4 md:hidden max-w-full overflow-hidden">

          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <GroupPill active={filter === "all"} color="#a3a3a3" label="All" count={q.data?.contacts.length ?? 0} onClick={() => setFilter("all")} />
            <GroupPill active={filter === "ungrouped"} color="#71717a" label="Ungrouped" count={ungroupedCount} onClick={() => setFilter("ungrouped")} />
            {(gq.data?.groups ?? []).map((g) => (
              <GroupPill
                key={g.id}
                active={filter === g.id}
                color={g.color}
                label={g.name}
                count={g.count}
                onClick={() => setFilter(g.id)}
                onEdit={() => setGroupDialog({ mode: "edit", group: g })}
              />
            ))}
            <button
              onClick={() => setGroupDialog({ mode: "create" })}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" /> New
            </button>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)] min-w-0">
          {/* Groups rail (desktop) */}
          <aside className="hidden md:block md:sticky md:top-2 md:self-start">
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
          <div className="min-w-0">
            <div className="mb-4 flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, or company…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Button
                variant={groupByCompany ? "default" : "outline"}
                size="sm"
                onClick={() => setGroupByCompany((v) => !v)}
                title="Group by company"
                aria-pressed={groupByCompany}
                className="shrink-0 px-2 sm:px-3"
              >
                <Building2 className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">By company</span>
              </Button>
            </div>

            {q.isLoading ? (
              <div className="grid gap-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="h-14 animate-pulse rounded-md border border-border bg-card/40" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {query ? "No matches." : "No contacts yet. Scan a card or add one manually."}
              </p>
            ) : groupByCompany ? (
              <div className="space-y-3">
                {companyBuckets.map((b) => {
                  const isCollapsed = collapsed.has(b.key);
                  return (
                    <section key={b.key} className="overflow-hidden rounded-md">
                      <CompanyBucketHeader
                        domain={b.domain}
                        name={b.name}
                        count={b.contacts.length}
                        collapsed={isCollapsed}
                        onToggle={() => toggleBucket(b.key)}
                        aliasCount={b.kind === "company" && b.domain ? (aliasesByPrimary.get(b.domain)?.length ?? 0) : 0}
                        logoProvider={b.kind === "company" && b.domain ? (logoProviderByDomain.get(b.domain) ?? null) : null}
                        onEdit={b.kind === "company" && b.domain
                          ? () => setAliasDialog({ domain: b.domain!, name: b.name })
                          : undefined}
                      />
                      {!isCollapsed && (
                        <ul className="divide-y divide-border border-x border-b border-border bg-card/40">
                          {b.contacts.map((c) => {
                            const gids = contactGroupMap.get(c.id) ?? [];
                            return (
                              <li key={c.id}>
                                <button
                                  onClick={() => setDrawerId(c.id)}
                                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/40"
                                >
                                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                                    {(c.name || c.email).slice(0, 1).toUpperCase()}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-foreground">{c.name || c.email}</div>
                                    <div className="truncate text-xs text-muted-foreground">{c.email}</div>
                                  </div>
                                  {gids.length > 0 && (
                                    <div className="flex items-center gap-1">
                                      {gids.slice(0, 4).map((gid) => {
                                        const g = groupsById.get(gid);
                                        if (!g) return null;
                                        return (
                                          <span key={gid} className="h-2 w-2 rounded-full" style={{ background: g.color }} title={g.name} />
                                        );
                                      })}
                                    </div>
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border bg-card/40">
                {filtered.map((c) => {
                  const gids = contactGroupMap.get(c.id) ?? [];
                  const dom = contactLogoDomain((c as any).website, c.email);
                  const resolvedDom = resolveCompanyDomain(dom, aliasMap);
                  const logoProv = resolvedDom ? (logoProviderByDomain.get(resolvedDom) ?? null) : null;
                  const showLogo = !!dom;
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => setDrawerId(c.id)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/40"
                      >
                        {showLogo ? (
                          <CompanyLogo domain={resolvedDom ?? dom} name={c.company ?? prettyCompanyName(dom!)} size={40} className="rounded-full" provider={logoProv} />
                        ) : (
                          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
                            {(c.name || c.email).slice(0, 1).toUpperCase()}
                          </div>
                        )}
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

      <AddContactsDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => qc.invalidateQueries({ queryKey: ["contacts"] })}
      />

      <ContactDrawer
        contactId={drawerId}
        open={!!drawerId}
        onOpenChange={(v) => !v && setDrawerId(null)}
      />

      <CompanyAliasesDialog
        open={!!aliasDialog}
        onOpenChange={(v) => !v && setAliasDialog(null)}
        primaryDomain={aliasDialog?.domain ?? null}
        companyName={aliasDialog?.name ?? ""}
        aliases={aliasDialog ? (aliasesByPrimary.get(aliasDialog.domain) ?? []) : []}
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

function GroupPill({
  active, color, label, count, onClick, onEdit,
}: {
  active: boolean; color: string; label: string; count?: number;
  onClick: () => void; onEdit?: () => void;
}) {
  return (
    <div className={`inline-flex shrink-0 items-center rounded-full border text-xs ${active ? "border-foreground/30 bg-accent text-accent-foreground" : "border-border bg-card/60 text-foreground"}`}>
      <button onClick={onClick} className="flex items-center gap-1.5 py-1.5 pl-2.5 pr-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <span className="max-w-[140px] truncate">{label}</span>
        {typeof count === "number" && (
          <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">{count}</span>
        )}
      </button>
      {onEdit && active && (
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="mr-1 grid h-5 w-5 place-items-center rounded-full text-muted-foreground hover:bg-background/50 hover:text-foreground"
          aria-label={`Edit ${label}`}
        >
          <Pencil className="h-3 w-3" />
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
  const s = state;
  const editing = s.mode === "edit";
  const editGroup = s.mode === "edit" ? s.group : null;

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (editGroup) {
        await update({ data: { id: editGroup.id, name: name.trim(), color } });
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
    if (!editGroup) return;
    if (!confirm(`Delete the “${editGroup.name}” group? Contacts won't be deleted.`)) return;
    setSaving(true);
    try {
      await del({ data: { id: editGroup.id } });
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

function AddContactsDialog({
  open, onOpenChange, onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const createManual = useServerFn(createContactManual);
  const listFolders = useServerFn(listFoldersForPicker);
  const listSenders = useServerFn(listUniqueInboxSenders);
  const bulkAdd = useServerFn(bulkCreateContactsFromEmails);

  const [tab, setTab] = useState<"manual" | "inbox">("manual");

  // Manual form state
  const [m, setM] = useState({ email: "", name: "", title: "", company: "", phone: "", website: "", linkedin: "", twitter: "" });
  const [saving, setSaving] = useState(false);

  // Inbox tab state
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!open) {
      setM({ email: "", name: "", title: "", company: "", phone: "", website: "", linkedin: "", twitter: "" });
      setFolderIds([]); setSearch(""); setDebounced(""); setSelected(new Set()); setTab("manual");
    }
  }, [open]);

  const foldersQ = useQuery({
    queryKey: ["folders-picker"],
    queryFn: () => listFolders(),
    enabled: open,
  });

  const sendersQ = useQuery({
    queryKey: ["inbox-senders", folderIds.join(","), debounced],
    queryFn: () => listSenders({ data: { folderIds: folderIds.length ? folderIds : undefined, search: debounced || undefined } }),
    enabled: open && tab === "inbox",
  });

  async function submitManual() {
    if (!/.+@.+\..+/.test(m.email)) { toast.error("Enter a valid email"); return; }
    setSaving(true);
    try {
      await createManual({ data: {
        email: m.email,
        name: m.name || null, title: m.title || null, company: m.company || null,
        phone: m.phone || null, website: m.website || null, linkedin: m.linkedin || null, twitter: m.twitter || null,
      } });
      toast.success("Contact added");
      onAdded();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't add contact");
    } finally { setSaving(false); }
  }

  function toggleFolder(id: string) {
    setFolderIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  function toggleSender(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email); else next.add(email);
      return next;
    });
  }

  const senders = sendersQ.data?.senders ?? [];
  const allVisibleSelected = senders.length > 0 && senders.every((s) => selected.has(s.email));

  function selectAllVisible() {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of senders) next.delete(s.email);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of senders) next.add(s.email);
        return next;
      });
    }
  }

  async function submitBulk() {
    if (selected.size === 0) return;
    const items = senders
      .filter((s) => selected.has(s.email))
      .map((s) => ({ email: s.email, name: s.name }));
    if (items.length === 0) return;
    setAdding(true);
    try {
      const r = await bulkAdd({ data: { items } });
      toast.success(`Added ${r.created} ${r.created === 1 ? "contact" : "contacts"}`);
      onAdded();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't add contacts");
    } finally { setAdding(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Add contacts</DialogTitle>
          <DialogDescription>Enter someone manually or pick from senders in your inbox.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="manual"><UserPlus className="mr-2 h-4 w-4" /> Manual</TabsTrigger>
            <TabsTrigger value="inbox"><Inbox className="mr-2 h-4 w-4" /> From inbox</TabsTrigger>
          </TabsList>

          <TabsContent value="manual" className="space-y-3 pt-3 overflow-y-auto">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email *"><Input type="email" value={m.email} onChange={(e) => setM({ ...m, email: e.target.value })} placeholder="person@example.com" autoFocus /></Field>
              <Field label="Name"><Input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder="Jane Doe" /></Field>
              <Field label="Title"><Input value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} /></Field>
              <Field label="Company"><Input value={m.company} onChange={(e) => setM({ ...m, company: e.target.value })} /></Field>
              <Field label="Phone"><Input value={m.phone} onChange={(e) => setM({ ...m, phone: e.target.value })} /></Field>
              <Field label="Website"><Input value={m.website} onChange={(e) => setM({ ...m, website: e.target.value })} /></Field>
              <Field label="LinkedIn"><Input value={m.linkedin} onChange={(e) => setM({ ...m, linkedin: e.target.value })} /></Field>
              <Field label="Twitter / X"><Input value={m.twitter} onChange={(e) => setM({ ...m, twitter: e.target.value })} /></Field>
            </div>
            <DialogFooter className="pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button onClick={submitManual} disabled={saving || !m.email}>{saving ? "Adding…" : "Add contact"}</Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="inbox" className="flex flex-col min-h-0 pt-3 gap-3">
            <div>
              <Label className="mb-1.5 block text-xs uppercase tracking-widest text-muted-foreground">Search in folders</Label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setFolderIds([])}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${folderIds.length === 0 ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-muted-foreground hover:text-foreground"}`}
                >
                  All folders
                </button>
                {(foldersQ.data?.folders ?? []).map((f: any) => {
                  const on = folderIds.includes(f.id);
                  return (
                    <button
                      key={f.id}
                      onClick={() => toggleFolder(f.id)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${on ? "border-foreground/40 bg-accent text-accent-foreground" : "border-border bg-card/60 text-foreground hover:bg-accent/40"}`}
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: f.color }} />
                      {f.name}
                      {on && <Check className="h-3 w-3" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search senders by name or email…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <button onClick={selectAllVisible} disabled={senders.length === 0} className="underline-offset-2 hover:underline disabled:opacity-50">
                {allVisibleSelected ? "Unselect all" : "Select all visible"}
              </button>
              <span>{selected.size} selected</span>
            </div>

            <div className="flex-1 min-h-[200px] max-h-[40vh] overflow-y-auto rounded-md border border-border bg-card/40">
              {sendersQ.isLoading ? (
                <div className="p-4 text-sm text-muted-foreground">Loading senders…</div>
              ) : senders.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">No new senders found in this scope.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {senders.map((s) => {
                    const checked = selected.has(s.email);
                    return (
                      <li key={s.email}>
                        <button
                          onClick={() => toggleSender(s.email)}
                          className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent/40"
                        >
                          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"}`}>
                            {checked && <Check className="h-3.5 w-3.5" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground">{s.name || s.email}</div>
                            <div className="truncate text-xs text-muted-foreground">{s.email}</div>
                          </div>
                          <div className="text-right text-[11px] text-muted-foreground shrink-0">
                            <div>{s.count} {s.count === 1 ? "msg" : "msgs"}</div>
                            {s.lastReceivedAt && <div>{new Date(s.lastReceivedAt).toLocaleDateString()}</div>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={adding}>Cancel</Button>
              <Button onClick={submitBulk} disabled={adding || selected.size === 0}>
                {adding ? "Adding…" : `Add ${selected.size || ""} ${selected.size === 1 ? "contact" : "contacts"}`}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
