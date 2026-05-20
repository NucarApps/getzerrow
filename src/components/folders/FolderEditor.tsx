import { useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  learnFolderFromLabel,
  listFolderDomainSuggestions,
  addDomainFilter,
  reassignDomainToFolder,
  listFolderHistory,
  suggestRecategorization,
  applyRecategorization,
  listFolderSummaries,
  createFolderSummary,
  updateFolderSummary,
  deleteFolderSummary,
  runFolderSummaryNow,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, X, Sparkles, Link2, ArrowRight, History, Loader2, MoveRight, Clock, Play, Pencil, ChevronDown, Bot, Hand, Filter as FilterIcon, Tag, Inbox, MoreVertical } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

export type Folder = {
  id: string;
  name: string;
  color: string;
  gmail_label_id: string | null;
  ai_rule: string | null;
  learned_profile: string | null;
  last_learned_at: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  priority: number;
  gmail_account_id: string;
};
export type Filter = { id: string; folder_id: string; field: string; op: string; value: string };
export type GLabel = { id: string; name: string; type: string };

const reasonLabel: Record<string, string> = {
  gmail_label: "Gmail label",
  filter: "Filter match",
  domain_rule: "Domain rule",
  manual_move: "Moved manually",
  ai: "AI",
  none: "Unclassified",
};

export function FolderEditor({
  folder,
  labels,
  onDeleted,
}: {
  folder: Folder;
  labels: GLabel[];
  onDeleted?: () => void;
}) {
  const qc = useQueryClient();
  const learnFn = useServerFn(learnFolderFromLabel);
  const listDomainsFn = useServerFn(listFolderDomainSuggestions);
  const addDomainFn = useServerFn(addDomainFilter);
  const reassignFn = useServerFn(reassignDomainToFolder);
  const historyFn = useServerFn(listFolderHistory);
  const suggestFn = useServerFn(suggestRecategorization);
  const applyFn = useServerFn(applyRecategorization);
  const [local, setLocal] = useState(folder);
  const [pickerOpen, setPickerOpen] = useState<string | null>(null);
  const [newF, setNewF] = useState({ field: "from", op: "contains", value: "" });
  const [learning, setLearning] = useState(false);
  const dirty = JSON.stringify(local) !== JSON.stringify(folder);
  const linkedLabel = labels.find((l) => l.id === folder.gmail_label_id);

  const filtersQ = useQuery({
    queryKey: ["folder-filters", folder.id],
    queryFn: async () => {
      const { data } = await supabase.from("folder_filters").select("*").eq("folder_id", folder.id);
      return (data ?? []) as Filter[];
    },
  });
  const filters = filtersQ.data ?? [];

  const exampleCountQ = useQuery({
    queryKey: ["folder-example-count", folder.id],
    queryFn: async () => {
      const { count } = await supabase.from("folder_examples").select("id", { count: "exact", head: true }).eq("folder_id", folder.id);
      return count ?? 0;
    },
  });
  const exampleCount = exampleCountQ.data ?? 0;

  const domainsQ = useQuery({
    queryKey: ["folder-domains", folder.id, exampleCount],
    enabled: exampleCount > 0,
    queryFn: async () => (await listDomainsFn({ data: { folder_id: folder.id } })).suggestions,
    placeholderData: (prev) => prev,
  });

  const otherFoldersQ = useQuery({
    queryKey: ["folders-picker", folder.gmail_account_id, folder.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("folders")
        .select("id, name, color")
        .eq("gmail_account_id", folder.gmail_account_id)
        .neq("id", folder.id)
        .order("name");
      return (data ?? []) as Array<{ id: string; name: string; color: string }>;
    },
  });

  async function save() {
    const { error } = await supabase.from("folders").update({
      name: local.name, color: local.color, ai_rule: local.ai_rule,
      gmail_label_id: local.gmail_label_id,
      auto_archive: local.auto_archive, auto_mark_read: local.auto_mark_read, priority: local.priority,
    }).eq("id", folder.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["folders"] });
    qc.invalidateQueries({ queryKey: ["folders-full"] });
  }
  async function remove() {
    if (!confirm(`Delete "${folder.name}"?`)) return;
    await supabase.from("folders").delete().eq("id", folder.id);
    qc.invalidateQueries({ queryKey: ["folders"] });
    qc.invalidateQueries({ queryKey: ["folders-full"] });
    onDeleted?.();
  }
  async function addFilter() {
    if (!newF.value.trim()) return;
    await supabase.from("folder_filters").insert({ ...newF, folder_id: folder.id, value: newF.value.trim() });
    setNewF({ field: "from", op: "contains", value: "" });
    qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
  }
  async function removeFilter(id: string) {
    await supabase.from("folder_filters").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
  }
  async function addDomain(domain: string) {
    const key = ["folder-domains", folder.id, exampleCount];
    const prev = qc.getQueryData<Array<{ domain: string; count: number }>>(key);
    qc.setQueryData(key, (old: Array<{ domain: string; count: number }> | undefined) =>
      (old ?? []).filter((s) => s.domain !== domain),
    );
    try {
      await addDomainFn({ data: { folder_id: folder.id, domain } });
      toast.success(`Now routing ${domain} → ${folder.name}`);
      qc.invalidateQueries({ queryKey: ["folder-filters", folder.id] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
    } catch (e: any) {
      qc.setQueryData(key, prev);
      toast.error(e.message ?? "Failed to add");
    }
  }
  async function reassignDomain(domain: string, toFolderId: string, toName: string) {
    const key = ["folder-domains", folder.id, exampleCount];
    const prev = qc.getQueryData<Array<{ domain: string; count: number }>>(key);
    qc.setQueryData(key, (old: Array<{ domain: string; count: number }> | undefined) =>
      (old ?? []).filter((s) => s.domain !== domain),
    );
    setPickerOpen(null);
    try {
      const r = await reassignFn({ data: { from_folder_id: folder.id, to_folder_id: toFolderId, domain } });
      toast.success(`Moved ${r.moved} email${r.moved === 1 ? "" : "s"} to ${toName} · routing future ${domain}`);
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["folder-filters", toFolderId] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
    } catch (e: any) {
      qc.setQueryData(key, prev);
      toast.error(e.message ?? "Failed to move");
    }
  }
  async function learn() {
    if (!folder.gmail_label_id) { toast.error("Link a Gmail label first, then save."); return; }
    setLearning(true);
    try {
      const r = await learnFn({ data: { folder_id: folder.id } });
      const bits: string[] = [];
      if (r.learned) bits.push(`learned from ${r.learned}`);
      if (r.ingested) bits.push(`imported ${r.ingested}`);
      if (r.claimed) bits.push(`tagged ${r.claimed}`);
      if (bits.length === 0) toast.warning("No emails found under linked label in the past 30 days.");
      else toast.success(bits.join(" · "));
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      qc.invalidateQueries({ queryKey: ["folder-example-count", folder.id] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
      qc.invalidateQueries({ queryKey: ["emails"] });
    } catch (e: any) { toast.error(e.message ?? "Failed to learn"); }
    finally { setLearning(false); }
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <input type="color" value={local.color} onChange={(e) => setLocal({ ...local, color: e.target.value })} className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent" />
        <Input className="flex-1" value={local.name} onChange={(e) => setLocal({ ...local, name: e.target.value })} />
        <Input type="number" className="w-20" value={local.priority} onChange={(e) => setLocal({ ...local, priority: parseInt(e.target.value) || 0 })} title="Priority (higher wins)" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More actions"><MoreVertical className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={remove} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-4 w-4" /> Delete folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Tabs defaultValue="settings" className="mt-4">
        <TabsList>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="history">
            <History className="mr-1.5 h-3.5 w-3.5" /> History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="mt-4">
          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground"><Link2 className="mr-1 inline h-3 w-3" />Gmail label</Label>
            <Select value={local.gmail_label_id ?? ""} onValueChange={(v) => setLocal({ ...local, gmail_label_id: v || null })}>
              <SelectTrigger><SelectValue placeholder="Not linked" /></SelectTrigger>
              <SelectContent>
                {labels.map((l) => (<SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">AI rule (natural language)</Label>
            <Textarea className="mt-1.5" rows={2} placeholder='e.g. "Newsletters, marketing emails"' value={local.ai_rule ?? ""} onChange={(e) => setLocal({ ...local, ai_rule: e.target.value })} />
          </div>

          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" /> Learned profile
              </div>
              <Button size="sm" variant="outline" onClick={learn} disabled={learning || !folder.gmail_label_id}>
                {learning ? "Learning…" : folder.last_learned_at ? "Re-learn" : "Learn from existing emails"}
              </Button>
            </div>
            <p className="mt-2 text-sm text-foreground/80">
              {folder.learned_profile || <span className="text-muted-foreground italic">Not learned yet. {linkedLabel ? `Linked to "${linkedLabel.name}".` : "Link a Gmail label and save first."}</span>}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {exampleCount} example{exampleCount === 1 ? "" : "s"}
              {folder.last_learned_at && ` · learned ${new Date(folder.last_learned_at).toLocaleString()}`}
              {" · "}auto-updates as you move emails in Gmail
            </p>
            {(domainsQ.data?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">Suggested domains</div>
                <div className="flex flex-wrap gap-1.5">
                  {domainsQ.data!.map((s) => (
                    <div
                      key={s.domain}
                      className="inline-flex items-stretch rounded-full border border-border bg-background text-xs overflow-hidden hover:border-primary transition-colors"
                    >
                      <button
                        onClick={() => addDomain(s.domain)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 hover:bg-primary/5"
                        title={`Auto-route all ${s.domain} emails to ${folder.name}`}
                      >
                        <Plus className="h-3 w-3" />
                        <span className="font-mono">{s.domain}</span>
                        <span className="text-muted-foreground">· {s.count}</span>
                      </button>
                      <Popover open={pickerOpen === s.domain} onOpenChange={(o) => setPickerOpen(o ? s.domain : null)}>
                        <PopoverTrigger asChild>
                          <button
                            className="inline-flex items-center justify-center border-l border-border px-1.5 hover:bg-primary/5"
                            title={`Move ${s.domain} to a different folder`}
                          >
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-56 p-1" align="end">
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            Move {s.domain} to…
                          </div>
                          {(otherFoldersQ.data ?? []).length === 0 ? (
                            <div className="px-2 py-2 text-xs text-muted-foreground italic">No other folders</div>
                          ) : (
                            <div className="max-h-64 overflow-y-auto">
                              {(otherFoldersQ.data ?? []).map((f) => (
                                <button
                                  key={f.id}
                                  onClick={() => reassignDomain(s.domain, f.id, f.name)}
                                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent text-left"
                                >
                                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: f.color }} />
                                  <span className="truncate">{f.name}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <SummariesPanel folderId={folder.id} />

          <div className="mt-4 grid grid-cols-2 gap-4">
            <label className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              Auto-archive
              <Switch checked={local.auto_archive} onCheckedChange={(v) => setLocal({ ...local, auto_archive: v })} />
            </label>
            <label className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              Auto mark-read
              <Switch checked={local.auto_mark_read} onCheckedChange={(v) => setLocal({ ...local, auto_mark_read: v })} />
            </label>
          </div>

          <div className="mt-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Filters</Label>
            <div className="mt-2 space-y-1.5">
              {filters.map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
                  <span className="text-muted-foreground">{f.field}</span>
                  <span className="text-muted-foreground">{f.op}</span>
                  <span className="flex-1 font-mono text-xs">{f.value}</span>
                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => removeFilter(f.id)}><X className="h-3 w-3" /></Button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <Select value={newF.field} onValueChange={(v) => setNewF({ ...newF, field: v })}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="from">from</SelectItem>
                    <SelectItem value="to">to</SelectItem>
                    <SelectItem value="subject">subject</SelectItem>
                    <SelectItem value="body">body</SelectItem>
                    <SelectItem value="domain">domain</SelectItem>
                    <SelectItem value="has_attachment">has_attachment</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={newF.op} onValueChange={(v) => setNewF({ ...newF, op: v })}>
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">contains</SelectItem>
                    <SelectItem value="equals">equals</SelectItem>
                    <SelectItem value="regex">regex</SelectItem>
                  </SelectContent>
                </Select>
                <Input className="flex-1" placeholder="value" value={newF.value} onChange={(e) => setNewF({ ...newF, value: e.target.value })} />
                <Button size="sm" onClick={addFilter}>Add</Button>
              </div>
            </div>
          </div>

          {dirty && (
            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setLocal(folder)}>Cancel</Button>
              <Button size="sm" onClick={save}>Save changes</Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <HistoryPanel
            folder={folder}
            otherFolders={otherFoldersQ.data ?? []}
            historyFn={historyFn}
            suggestFn={suggestFn}
            applyFn={applyFn}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type HistoryEmail = {
  id: string;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  received_at: string | null;
  classified_by: string | null;
  ai_confidence: number | null;
  ai_summary: string | null;
  snippet: string | null;
};

type ReasonTone = "ai" | "manual" | "rule" | "label" | "muted";
const reasonMeta: Record<string, { label: string; tone: ReasonTone; Icon: typeof Bot }> = {
  ai: { label: "AI", tone: "ai", Icon: Bot },
  manual_move: { label: "Manual", tone: "manual", Icon: Hand },
  filter: { label: "Rule", tone: "rule", Icon: FilterIcon },
  domain_rule: { label: "Domain rule", tone: "rule", Icon: FilterIcon },
  gmail_label: { label: "Gmail label", tone: "label", Icon: Tag },
  none: { label: "Imported", tone: "muted", Icon: Inbox },
};
const toneClass: Record<ReasonTone, string> = {
  ai: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 border-indigo-500/20",
  manual: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/20",
  rule: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20",
  label: "bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/20",
  muted: "bg-muted/60 text-muted-foreground border-border",
};

function getReasonMeta(by: string | null | undefined) {
  return reasonMeta[by ?? "none"] ?? reasonMeta.none;
}

function relativeTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

type SuggestionResult = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof suggestRecategorization>>>>;

function HistoryPanel({
  folder,
  otherFolders,
  historyFn,
  suggestFn,
  applyFn,
}: {
  folder: Folder;
  otherFolders: Array<{ id: string; name: string; color: string }>;
  historyFn: ReturnType<typeof useServerFn<typeof listFolderHistory>>;
  suggestFn: ReturnType<typeof useServerFn<typeof suggestRecategorization>>;
  applyFn: ReturnType<typeof useServerFn<typeof applyRecategorization>>;
}) {
  const qc = useQueryClient();
  const PAGE = 25;
  const [pageCount, setPageCount] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [activeEmail, setActiveEmail] = useState<string | null>(null);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [suggestion, setSuggestion] = useState<SuggestionResult | null>(null);
  const [applySource, setApplySource] = useState(true);
  const [applyTarget, setApplyTarget] = useState(true);
  const [applying, setApplying] = useState(false);

  const historyQ = useQuery({
    queryKey: ["folder-history", folder.id, pageCount],
    queryFn: async () => {
      const r = await historyFn({ data: { folder_id: folder.id, limit: PAGE * pageCount, offset: 0 } });
      return r as { emails: HistoryEmail[]; has_more: boolean; next_offset: number };
    },
  });

  // Load folder filters to show which rule matched (best-effort)
  const filtersQ = useQuery({
    queryKey: ["folder-filters-history", folder.id],
    queryFn: async () => {
      const { data } = await supabase.from("folder_filters").select("*").eq("folder_id", folder.id);
      return (data ?? []) as Filter[];
    },
  });
  const folderFilters = filtersQ.data ?? [];

  async function startSuggestion(emailId: string, toFolderId: string) {
    setPickerFor(null);
    setActiveEmail(emailId);
    setSuggestion(null);
    setApplySource(true);
    setApplyTarget(true);
    setLoadingSuggest(true);
    try {
      const r = await suggestFn({ data: { email_id: emailId, to_folder_id: toFolderId } });
      setSuggestion(r);
      if (r.error) toast.warning(r.error);
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to get suggestion");
      setActiveEmail(null);
    } finally {
      setLoadingSuggest(false);
    }
  }

  async function apply() {
    if (!activeEmail || !suggestion) return;
    setApplying(true);
    try {
      await applyFn({
        data: {
          email_id: activeEmail,
          to_folder_id: suggestion.target.id,
          apply_source: applySource,
          apply_target: applyTarget,
          source_rule: applySource ? suggestion.source.proposed_rule : undefined,
          source_profile: applySource ? suggestion.source.proposed_profile : undefined,
          target_rule: applyTarget ? suggestion.target.proposed_rule : undefined,
          target_profile: applyTarget ? suggestion.target.proposed_profile : undefined,
        },
      });
      toast.success(`Moved to ${suggestion.target.name}`);
      setActiveEmail(null);
      setSuggestion(null);
      setExpanded(null);
      qc.invalidateQueries({ queryKey: ["folder-history", folder.id] });
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to apply");
    } finally {
      setApplying(false);
    }
  }

  if (historyQ.isLoading) {
    return <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading history…</div>;
  }
  const emails = historyQ.data?.emails ?? [];
  const hasMore = historyQ.data?.has_more ?? false;
  if (emails.length === 0) {
    return <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No emails have been processed into this folder yet.</div>;
  }

  return (
    <div className="space-y-2">
      {emails.map((e) => {
        const isOpen = expanded === e.id;
        const isActive = activeEmail === e.id;
        const meta = getReasonMeta(e.classified_by);
        const conf = e.ai_confidence != null ? Math.round(e.ai_confidence * 100) : null;
        const ReasonIcon = meta.Icon;
        return (
          <div key={e.id} className="overflow-hidden rounded-md border border-border bg-card/40">
            <button
              type="button"
              onClick={() => {
                setExpanded(isOpen ? null : e.id);
                if (isOpen && isActive) { setActiveEmail(null); setSuggestion(null); }
              }}
              className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{e.subject || "(no subject)"}</div>
                <div className="truncate text-xs text-muted-foreground">
                  <span>{e.from_name || e.from_addr || "Unknown"}</span>
                  {e.received_at && <span> · {relativeTime(e.received_at)}</span>}
                </div>
              </div>
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass[meta.tone]}`}>
                <ReasonIcon className="h-3 w-3" />
                {meta.label}{e.classified_by === "ai" && conf != null ? ` ${conf}%` : ""}
              </span>
              <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
            </button>

            {isOpen && (
              <div className="border-t border-border bg-muted/10 p-3 space-y-3">
                <ReasonBlock email={e} folderName={folder.name} filters={folderFilters} />

                {e.snippet && (
                  <div className="rounded-md border border-border bg-background/60 p-2.5 text-xs text-foreground/80 line-clamp-3">
                    {e.snippet}
                  </div>
                )}

                {!isActive && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Popover open={pickerFor === e.id} onOpenChange={(o) => setPickerFor(o ? e.id : null)}>
                      <PopoverTrigger asChild>
                        <Button size="sm" variant="outline">
                          <MoveRight className="mr-1.5 h-3.5 w-3.5" /> Move to…
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-60 p-1" align="start">
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">Should go to…</div>
                        {otherFolders.length === 0 ? (
                          <div className="px-2 py-2 text-xs text-muted-foreground italic">No other folders</div>
                        ) : (
                          <div className="max-h-64 overflow-y-auto">
                            {otherFolders.map((f) => (
                              <button
                                key={f.id}
                                onClick={() => startSuggestion(e.id, f.id)}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent text-left"
                              >
                                <span className="h-2.5 w-2.5 rounded-full" style={{ background: f.color }} />
                                <span className="truncate">{f.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                    <span className="text-xs text-muted-foreground">Wrong folder? Pick where it belongs.</span>
                  </div>
                )}

                {isActive && (
                  <div className="rounded-md border border-border bg-background p-3">
                    {loadingSuggest && (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Asking AI for rule updates…
                      </div>
                    )}
                    {suggestion && (
                      <div className="space-y-3">
                        <div className="text-xs text-muted-foreground">
                          Move 1 email · <span className="font-medium text-foreground">{suggestion.source.name}</span>
                          {" → "}
                          <span className="font-medium text-foreground">{suggestion.target.name}</span>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <RulePatchCard
                            title={`Source · ${suggestion.source.name}`}
                            current={suggestion.source.current_rule}
                            proposed={suggestion.source.proposed_rule}
                            why={suggestion.source.why}
                            checked={applySource}
                            onChange={setApplySource}
                          />
                          <RulePatchCard
                            title={`Target · ${suggestion.target.name}`}
                            current={suggestion.target.current_rule}
                            proposed={suggestion.target.proposed_rule}
                            why={suggestion.target.why}
                            checked={applyTarget}
                            onChange={setApplyTarget}
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => { setActiveEmail(null); setSuggestion(null); }} disabled={applying}>Cancel</Button>
                          <Button size="sm" onClick={apply} disabled={applying}>
                            {applying ? "Applying…" : "Apply"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {hasMore && (
        <div className="pt-2 flex justify-center">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPageCount((c) => c + 1)}
            disabled={historyQ.isFetching}
          >
            {historyQ.isFetching ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Loading…</> : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ReasonBlock({ email, folderName, filters }: { email: HistoryEmail; folderName: string; filters: Filter[] }) {
  const by = email.classified_by ?? "none";
  const meta = getReasonMeta(by);
  const Icon = meta.Icon;

  let title = "";
  let body: ReactNode = null;

  if (by === "ai") {
    const conf = email.ai_confidence != null ? Math.round(email.ai_confidence * 100) : null;
    title = `Classified by AI${conf != null ? ` · ${conf}% confidence` : ""}`;
    body = email.ai_summary
      ? <blockquote className="border-l-2 border-indigo-500/40 pl-3 italic text-foreground/80">"{email.ai_summary}"</blockquote>
      : <span className="text-muted-foreground italic">No reason recorded.</span>;
  } else if (by === "manual_move") {
    title = "Moved here manually";
    body = <span className="text-muted-foreground">You (or a connected Gmail action) moved this email into <span className="font-medium text-foreground">{folderName}</span>.</span>;
  } else if (by === "filter" || by === "domain_rule") {
    const matched = matchFilter(email, filters);
    title = by === "domain_rule" ? "Matched a domain rule" : "Matched a folder rule";
    body = matched
      ? <span>Matched <code className="rounded bg-muted px-1 py-0.5 text-xs">{matched.field} {matched.op} "{matched.value}"</code></span>
      : <span className="text-muted-foreground">Matched one of this folder's rules.</span>;
  } else if (by === "gmail_label") {
    title = "Imported from Gmail label";
    body = <span className="text-muted-foreground">This email already had the matching Gmail label when it was synced.</span>;
  } else {
    title = "Imported with this folder";
    body = <span className="text-muted-foreground">No classifier ran on this email yet.</span>;
  }

  return (
    <div className="rounded-md border border-border bg-background p-3 text-sm">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <div className="mt-1.5">{body}</div>
    </div>
  );
}

function matchFilter(email: HistoryEmail, filters: Filter[]): Filter | null {
  for (const f of filters) {
    const value = (f.value || "").toLowerCase();
    if (!value) continue;
    const target = (() => {
      switch (f.field) {
        case "from": return (email.from_addr || "") + " " + (email.from_name || "");
        case "subject": return email.subject || "";
        case "snippet":
        case "body": return email.snippet || "";
        default: return "";
      }
    })().toLowerCase();
    const op = f.op || "contains";
    const hit = op === "equals" ? target === value
      : op === "starts_with" ? target.startsWith(value)
      : op === "ends_with" ? target.endsWith(value)
      : target.includes(value);
    if (hit) return f;
  }
  return null;
}

function RulePatchCard({
  title, current, proposed, why, checked, onChange,
}: {
  title: string;
  current: string | null;
  proposed: string;
  why: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  const changed = (current ?? "").trim() !== (proposed ?? "").trim();
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} disabled={!changed} />
          Update rule
        </label>
      </div>
      <div className="mt-2 space-y-2 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Current</div>
          <div className="text-foreground/80">{current || <span className="italic text-muted-foreground">(empty)</span>}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Proposed</div>
          <div className={changed ? "text-foreground" : "text-muted-foreground italic"}>
            {changed ? proposed : "No change suggested"}
          </div>
        </div>
        {why && <div className="text-xs text-muted-foreground italic">{why}</div>}
      </div>
    </div>
  );
}

// ============ Daily summaries ============

type Schedule = {
  id: string;
  name: string;
  instructions: string;
  hour: number;
  minute: number;
  timezone: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  last_error: string | null;
};

const browserTz = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
})();

function pad2(n: number) { return n < 10 ? `0${n}` : String(n); }

function SummariesPanel({ folderId }: { folderId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listFolderSummaries);
  const createFn = useServerFn(createFolderSummary);
  const updateFn = useServerFn(updateFolderSummary);
  const deleteFn = useServerFn(deleteFolderSummary);
  const runNowFn = useServerFn(runFolderSummaryNow);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["folder-summaries", folderId],
    queryFn: async () => (await listFn({ data: { folder_id: folderId } })).schedules as Schedule[],
  });
  const schedules = q.data ?? [];

  async function toggleEnabled(s: Schedule, enabled: boolean) {
    try {
      await updateFn({ data: { id: s.id, enabled } });
      qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
    } catch (e: any) { toast.error(e?.message ?? "Failed"); }
  }
  async function remove(s: Schedule) {
    if (!confirm(`Delete summary "${s.name}"?`)) return;
    await deleteFn({ data: { id: s.id } });
    qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
  }
  async function runNow(s: Schedule) {
    setRunningId(s.id);
    try {
      const r = await runNowFn({ data: { id: s.id } });
      if (r.ok) toast.success(r.emails === 0 ? "Ran — no emails in window" : `Inserted digest of ${r.emails} email${r.emails === 1 ? "" : "s"}`);
      else toast.error(r.error ?? "Failed");
      qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
    } catch (e: any) { toast.error(e?.message ?? "Failed"); }
    finally { setRunningId(null); }
  }

  return (
    <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Clock className="h-3 w-3" /> Daily summaries
        </div>
        {!showForm && !editing && (
          <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add schedule
          </Button>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Zerrow reads emails received in this folder over the last 24 hours and inserts an AI-written digest into your inbox at the time you choose.
      </p>

      {q.isLoading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</div>
      ) : (
        <div className="mt-3 space-y-2">
          {schedules.map((s) => (
            editing?.id === s.id ? (
              <ScheduleForm
                key={s.id}
                initial={s}
                onCancel={() => setEditing(null)}
                onSave={async (vals) => {
                  await updateFn({ data: { id: s.id, ...vals } });
                  setEditing(null);
                  qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
                }}
              />
            ) : (
              <div key={s.id} className="rounded-md border border-border bg-background p-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Every day at {pad2(s.hour)}:{pad2(s.minute)} ({s.timezone})
                    </div>
                    {s.instructions && (
                      <div className="mt-1 text-xs text-foreground/70 line-clamp-2">{s.instructions}</div>
                    )}
                    <div className="mt-1.5 text-xs text-muted-foreground">
                      {s.last_run_at ? `Last run: ${new Date(s.last_run_at).toLocaleString()}` : "Not run yet"}
                      {" · "}Next: {new Date(s.next_run_at).toLocaleString()}
                    </div>
                    {s.last_error && (
                      <div className="mt-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                        {s.last_error}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch checked={s.enabled} onCheckedChange={(v) => toggleEnabled(s, v)} />
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => runNow(s)} disabled={runningId === s.id} title="Run now">
                      {runningId === s.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditing(s); setShowForm(false); }} title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => remove(s)} title="Delete">
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              </div>
            )
          ))}
          {schedules.length === 0 && !showForm && (
            <div className="text-xs text-muted-foreground italic">No schedules yet.</div>
          )}
          {showForm && (
            <ScheduleForm
              onCancel={() => setShowForm(false)}
              onSave={async (vals) => {
                await createFn({ data: { folder_id: folderId, ...vals } });
                setShowForm(false);
                qc.invalidateQueries({ queryKey: ["folder-summaries", folderId] });
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ScheduleForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Schedule;
  onSave: (vals: { name: string; instructions: string; hour: number; minute: number; timezone: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "Daily digest");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [hour, setHour] = useState(initial?.hour ?? 8);
  const [minute, setMinute] = useState(initial?.minute ?? 0);
  const [tz, setTz] = useState(initial?.timezone ?? browserTz);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) { toast.error("Name required"); return; }
    setSaving(true);
    try {
      await onSave({ name: name.trim(), instructions: instructions.trim(), hour, minute, timezone: tz.trim() || "UTC" });
    } catch (e: any) {
      toast.error(e?.message ?? "Failed");
    } finally { setSaving(false); }
  }

  return (
    <div className="rounded-md border border-border bg-background p-3 space-y-2.5">
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Name</Label>
        <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning newsletter digest" />
      </div>
      <div className="grid grid-cols-[1fr_1fr_1.5fr] gap-2">
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Hour</Label>
          <Select value={String(hour)} onValueChange={(v) => setHour(parseInt(v, 10))}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>{Array.from({ length: 24 }).map((_, i) => (<SelectItem key={i} value={String(i)}>{pad2(i)}</SelectItem>))}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Minute</Label>
          <Select value={String(minute)} onValueChange={(v) => setMinute(parseInt(v, 10))}>
            <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
            <SelectContent>{[0, 15, 30, 45].map((i) => (<SelectItem key={i} value={String(i)}>{pad2(i)}</SelectItem>))}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Timezone</Label>
          <Input className="mt-1" value={tz} onChange={(e) => setTz(e.target.value)} placeholder="America/New_York" />
        </div>
      </div>
      <div>
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Instructions</Label>
        <Textarea
          className="mt-1"
          rows={3}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Group by sender, surface action items, keep it under 10 bullets."
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={submit} disabled={saving}>{saving ? "Saving…" : initial ? "Save" : "Create"}</Button>
      </div>
    </div>
  );
}
