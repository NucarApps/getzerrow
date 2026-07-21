import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  learnFolderFromLabel,
  applyFolderLabelToLocal,
  listFolderDomainSuggestions,
  addDomainFilter,
  reassignDomainToFolder,
  listFolderHistory,
  suggestRecategorization,
  applyRecategorization,
  applyFolderBehaviorRetroactive,
  setFolderAutoRelearn,
  generateFolderAiRule,
  generateFolderAiRuleFromLabel,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Plus,
  Trash2,
  X,
  Sparkles,
  Link2,
  ArrowRight,
  History,
  Loader2,
  ChevronDown,
  Filter as FilterIcon,
  Tag,
  Inbox,
  MoreVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { validateRuleNode } from "@/lib/sync/filter-engine";
import { FolderChatPanel } from "./FolderChatPanel";
import { FolderHealthCard } from "./FolderHealthCard";
import { HistoryPanel } from "./editor/folder-history-panel";
import { SummariesPanel } from "./editor/folder-summaries-panel";
import { RuleGroupEditor } from "./editor/folder-rule-group-editor";
import { ScanGmailSection } from "./editor/folder-scan-gmail-section";
import type { Folder, Filter, GLabel } from "./editor/types";
export type { RuleNode, Folder, Filter, GLabel } from "./editor/types";

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
  const applyLabelFn = useServerFn(applyFolderLabelToLocal);
  const listDomainsFn = useServerFn(listFolderDomainSuggestions);
  const addDomainFn = useServerFn(addDomainFilter);
  const reassignFn = useServerFn(reassignDomainToFolder);
  const historyFn = useServerFn(listFolderHistory);
  const suggestFn = useServerFn(suggestRecategorization);
  const applyFn = useServerFn(applyRecategorization);
  const applyBehaviorFn = useServerFn(applyFolderBehaviorRetroactive);
  const setAutoRelearnFn = useServerFn(setFolderAutoRelearn);
  const generateRuleFn = useServerFn(generateFolderAiRule);
  const generateFromLabelFn = useServerFn(generateFolderAiRuleFromLabel);
  const [local, setLocal] = useState(folder);
  const [tab, setTab] = useState("rules");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [pickerOpen, setPickerOpen] = useState<string | null>(null);
  const [newF, setNewF] = useState({ field: "from", op: "contains", value: "" });
  const [learning, setLearning] = useState(false);
  const [syncingLabel, setSyncingLabel] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [generatingRule, setGeneratingRule] = useState(false);
  const [draftingFromLabel, setDraftingFromLabel] = useState(false);
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
      const { count } = await supabase
        .from("folder_examples")
        .select("id", { count: "exact", head: true })
        .eq("folder_id", folder.id);
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
    // Bounds/shape check before persisting — an oversized or malformed
    // rule tree would be inert at classify time (filter-engine caps), so
    // reject it here with the reason instead of saving a dead rule.
    if (local.filter_tree) {
      const v = validateRuleNode(local.filter_tree);
      if (!v.ok) {
        toast.error(`Can't save rule groups: ${v.reason}`);
        return;
      }
    }
    // Auto-activate: once the user gives the folder any intent (an AI prompt,
    // a filter tree, or a linked Gmail label), flip skip_ai off so the
    // classifier considers it. Folders with no intent stay inert (skip_ai
    // stays true) regardless of what the local toggle says.
    const trimmedAiRule = local.ai_rule?.trim() || null;
    const hasFilterTree = local.filter_tree != null;
    const hasGmailLabel = !!local.gmail_label_id;
    const hasIntent = !!trimmedAiRule || hasFilterTree || hasGmailLabel;
    const skipAi = hasIntent ? (local.skip_ai ?? false) : true;

    const { error } = await supabase
      .from("folders")
      .update({
        name: local.name,
        color: local.color,
        ai_rule: trimmedAiRule,
        gmail_label_id: local.gmail_label_id,
        auto_archive: local.auto_archive,
        auto_mark_read: local.auto_mark_read,
        priority: local.priority,
        filter_logic: local.filter_logic ?? "any",
        auto_star: local.auto_star ?? false,
        hide_from_inbox: local.hide_from_inbox ?? false,
        skip_ai: skipAi,
        filter_tree: local.filter_tree ?? null,
        forward_to: local.forward_to?.trim() || null,
        min_ai_confidence: Math.min(1, Math.max(0, local.min_ai_confidence ?? 0)),
        snooze_hours: Math.max(0, local.snooze_hours ?? 0),
        overrides_inbox_override: local.overrides_inbox_override ?? false,
        is_cold_email: local.is_cold_email ?? false,
        surface_ai_rule: local.surface_ai_rule?.trim() || null,
        surface_names: local.surface_names?.trim() || null,
      })
      .eq("id", folder.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Saved");
    qc.invalidateQueries({ queryKey: ["folders"] });
    qc.invalidateQueries({ queryKey: ["folders-full"] });
  }

  // Auto-save a single toggle column immediately, then optionally retroactively apply it.
  async function toggleBehavior(
    column:
      | "auto_mark_read"
      | "auto_archive"
      | "auto_star"
      | "hide_from_inbox"
      | "skip_ai"
      | "overrides_inbox_override"
      | "is_cold_email",
    value: boolean,
    retro: "mark_read" | "archive" | "star" | null,
  ) {
    const prev = local;
    setLocal({ ...local, [column]: value });
    const patch = { [column]: value } as Record<typeof column, boolean>;
    const { error } = await supabase.from("folders").update(patch).eq("id", folder.id);
    if (error) {
      setLocal(prev);
      toast.error(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: ["folders"] });
    qc.invalidateQueries({ queryKey: ["folders-full"] });
    if (value && retro) {
      try {
        const res = await applyBehaviorFn({ data: { folderId: folder.id, behavior: retro } });
        if (res.count > 0) {
          const noun =
            retro === "mark_read" ? "marked read" : retro === "archive" ? "archived" : "starred";
          toast.success(`${res.count} existing email${res.count === 1 ? "" : "s"} ${noun}`);
        }
      } catch (e) {
        toast.error(`Saved, but couldn't update existing emails: ${(e as Error).message}`);
      }
    }
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
    const value =
      newF.op === "domain_in"
        ? Array.from(
            new Set(
              newF.value
                .split(/[\s,;]+/)
                .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
                .filter(Boolean),
            ),
          ).join(",")
        : newF.value.trim();
    if (!value) return;
    await supabase.from("folder_filters").insert({ ...newF, folder_id: folder.id, value });
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
    } catch (e: unknown) {
      qc.setQueryData(key, prev);
      toast.error(e instanceof Error ? e.message : "Failed to add");
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
      const r = await reassignFn({
        data: { from_folder_id: folder.id, to_folder_id: toFolderId, domain },
      });
      toast.success(
        `Moved ${r.moved} email${r.moved === 1 ? "" : "s"} to ${toName} · routing future ${domain}`,
      );
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["folder-filters", toFolderId] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
    } catch (e: unknown) {
      qc.setQueryData(key, prev);
      toast.error(e instanceof Error ? e.message : "Failed to move");
    }
  }
  async function learn() {
    if (!folder.gmail_label_id) {
      toast.error("Link a Gmail label first, then save.");
      return;
    }
    setLearning(true);
    try {
      const r = await learnFn({ data: { folder_id: folder.id } });
      const bits: string[] = [];
      if (r.learned) bits.push(`learned from ${r.learned}`);
      if (r.ingested) bits.push(`imported ${r.ingested}`);
      if (r.claimed) bits.push(`tagged ${r.claimed}`);
      if (bits.length === 0) toast.warning("No new examples found. Already up to date.");
      else toast.success(bits.join(" · "));
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      qc.invalidateQueries({ queryKey: ["folder-example-count", folder.id] });
      qc.invalidateQueries({ queryKey: ["folder-domains", folder.id] });
      qc.invalidateQueries({ queryKey: ["emails"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to learn");
    } finally {
      setLearning(false);
    }
  }

  async function syncLabel() {
    if (!folder.gmail_label_id) {
      toast.error("Link a Gmail label first, then save.");
      return;
    }
    setSyncingLabel(true);
    try {
      const r = await applyLabelFn({ data: { folder_id: folder.id } });
      if (r.total === 0) toast.success("All emails in this folder already carry the Gmail label.");
      else
        toast.success(
          `Synced ${r.synced} of ${r.total} email${r.total === 1 ? "" : "s"} to Gmail${r.failed ? ` · ${r.failed} failed` : ""}.`,
        );
      qc.invalidateQueries({ queryKey: ["emails"] });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to sync labels");
    } finally {
      setSyncingLabel(false);
    }
  }

  async function generateRule() {
    if (!purpose.trim()) {
      toast.error("Describe what this folder is for first.");
      return;
    }
    setGeneratingRule(true);
    try {
      const r = await generateRuleFn({
        data: { purpose: purpose.trim(), folder_name: local.name },
      });
      setLocal((prev) => ({ ...prev, ai_rule: r.rule }));
      toast.success("AI rule generated. Review it, then save.");
    } catch (e: unknown) {
      const err = e as { status?: unknown; message?: unknown; cause?: { status?: unknown } };
      const status = err?.status ?? err?.cause?.status;
      if (status === 429) toast.error("Rate limit reached. Try again in a moment.");
      else if (status === 402) toast.error("Out of AI credits. Add credits to keep generating.");
      else toast.error(typeof err?.message === "string" ? err.message : "Failed to generate rule");
    } finally {
      setGeneratingRule(false);
    }
  }

  async function draftFromLabel() {
    if (!folder.gmail_label_id) {
      toast.error("Link a Gmail label first, then save.");
      return;
    }
    setDraftingFromLabel(true);
    try {
      const r = await generateFromLabelFn({ data: { folder_id: folder.id } });
      setLocal((prev) => ({ ...prev, ai_rule: r.rule }));
      toast.success("Draft ready — review, then save.");
    } catch (e: unknown) {
      const err = e as { status?: unknown; message?: unknown; cause?: { status?: unknown } };
      const status = err?.status ?? err?.cause?.status;
      if (status === 429) toast.error("Rate limit reached. Try again in a moment.");
      else if (status === 402) toast.error("Out of AI credits. Add credits to keep generating.");
      else toast.error(typeof err?.message === "string" ? err.message : "Failed to draft rule");
    } finally {
      setDraftingFromLabel(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <input
          type="color"
          value={local.color}
          onChange={(e) => setLocal({ ...local, color: e.target.value })}
          className="h-9 w-12 shrink-0 cursor-pointer rounded border border-border bg-transparent"
        />
        <Input
          className="min-w-0 flex-1"
          value={local.name}
          onChange={(e) => setLocal({ ...local, name: e.target.value })}
        />
        <Input
          type="number"
          className="w-20 shrink-0"
          value={local.priority}
          onChange={(e) => setLocal({ ...local, priority: parseInt(e.target.value) || 0 })}
          title="Priority (higher wins)"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="More actions">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={remove} className="text-destructive focus:text-destructive">
              <Trash2 className="mr-2 h-4 w-4" /> Delete folder…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        <TabsList>
          <TabsTrigger value="rules">
            <FilterIcon className="mr-1.5 h-3.5 w-3.5" /> Rules
          </TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles className="mr-1.5 h-3.5 w-3.5" /> AI
          </TabsTrigger>
          <TabsTrigger value="automation">
            <Inbox className="mr-1.5 h-3.5 w-3.5" /> Automation
          </TabsTrigger>
          <TabsTrigger value="history">
            <History className="mr-1.5 h-3.5 w-3.5" /> History
          </TabsTrigger>
          <TabsTrigger value="chat">
            <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Chat
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rules" className="mt-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground">
            <FilterIcon className="h-3.5 w-3.5" /> Rules
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Deterministic conditions are checked first. Anything they don't match can still be
            sorted by AI on the AI tab.
          </p>

          <div className="mt-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                Filters
              </Label>
              <div className="flex items-center gap-2">
                {!local.filter_tree && (
                  <div className="inline-flex rounded-md border border-border text-xs overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setLocal({ ...local, filter_logic: "any" })}
                      className={`px-2.5 py-1 ${(local.filter_logic ?? "any") === "any" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
                      title="Match if ANY include rule passes (OR)"
                    >
                      Match any
                    </button>
                    <button
                      type="button"
                      onClick={() => setLocal({ ...local, filter_logic: "all" })}
                      className={`px-2.5 py-1 border-l border-border ${local.filter_logic === "all" ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}
                      title="Match only if ALL include rules pass (AND)"
                    >
                      Match all
                    </button>
                  </div>
                )}
                <Button
                  size="sm"
                  variant={local.filter_tree ? "secondary" : "ghost"}
                  className="h-7 text-xs"
                  onClick={() => {
                    if (local.filter_tree) {
                      if (
                        !confirm(
                          "Switch back to the simple rule list? Your rule group will be discarded.",
                        )
                      )
                        return;
                      setLocal({ ...local, filter_tree: null });
                    } else {
                      setLocal({
                        ...local,
                        filter_tree: {
                          type: "group",
                          op: local.filter_logic === "all" ? "and" : "or",
                          children: [],
                        },
                      });
                    }
                  }}
                >
                  {local.filter_tree ? "Use simple list" : "Use rule groups…"}
                </Button>
              </div>
            </div>

            {local.filter_tree ? (
              <div className="mt-3">
                <RuleGroupEditor
                  node={local.filter_tree}
                  onChange={(n) => setLocal({ ...local, filter_tree: n })}
                  isRoot
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  Rule groups override the simple list. Exclude rules still always block.
                </p>
              </div>
            ) : null}

            <div className="mt-2 space-y-1.5">
              {filters.map((f) => {
                const isExclude =
                  f.op === "not_contains" || f.op === "not_equals" || f.op === "domain_in";
                return (
                  <div
                    key={f.id}
                    className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                      isExclude ? "border-destructive/40 bg-destructive/5" : "border-border"
                    }`}
                  >
                    {isExclude && (
                      <span className="rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-destructive">
                        {f.op === "domain_in" ? "Allowlist" : "Exclude"}
                      </span>
                    )}
                    <span className="text-muted-foreground">{f.field}</span>
                    <span className={isExclude ? "text-destructive" : "text-muted-foreground"}>
                      {f.op === "domain_in" ? "is one of" : f.op}
                    </span>
                    <span className="flex-1 min-w-0 break-all font-mono text-xs">{f.value}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      aria-label="Remove filter"
                      onClick={() => removeFilter(f.id)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                );
              })}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select value={newF.field} onValueChange={(v) => setNewF({ ...newF, field: v })}>
                  <SelectTrigger className="w-full sm:w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="from">from</SelectItem>
                    <SelectItem value="to">to</SelectItem>
                    <SelectItem value="cc">cc</SelectItem>
                    <SelectItem value="subject">subject</SelectItem>
                    <SelectItem value="body">body</SelectItem>
                    <SelectItem value="domain">domain</SelectItem>
                    <SelectItem value="list_id">list-id (newsletter)</SelectItem>
                    <SelectItem value="is_reply">is reply</SelectItem>
                    <SelectItem value="has_attachment">has attachment</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={newF.op} onValueChange={(v) => setNewF({ ...newF, op: v })}>
                  <SelectTrigger className="w-full sm:w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">contains</SelectItem>
                    <SelectItem value="equals">equals</SelectItem>
                    <SelectItem value="starts_with">starts with</SelectItem>
                    <SelectItem value="ends_with">ends with</SelectItem>
                    <SelectItem value="not_contains">does not contain</SelectItem>
                    <SelectItem value="not_equals">does not equal</SelectItem>
                    <SelectItem value="domain_in">domain is one of (allowlist)</SelectItem>
                    <SelectItem value="regex">regex</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  className="flex-1 min-w-0"
                  placeholder="value"
                  value={newF.value}
                  onChange={(e) => setNewF({ ...newF, value: e.target.value })}
                />
                <Button size="sm" className="w-full sm:w-auto" onClick={addFilter}>
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Exclude rules keep matching emails in your inbox even if a domain or other rule
                would route them here.
              </p>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="ai" className="mt-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground">
            <Sparkles className="h-3.5 w-3.5" /> AI
          </div>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            When no rule matches, AI uses these instructions and settings to sort the email.
          </p>

          <FolderHealthCard folderId={folder.id} />

          <div className="grid grid-cols-[auto_1fr] items-center gap-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              <Link2 className="mr-1 inline h-3 w-3" />
              Gmail label
            </Label>
            <Select
              value={local.gmail_label_id ?? ""}
              onValueChange={(v) => setLocal({ ...local, gmail_label_id: v || null })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Not linked" />
              </SelectTrigger>
              <SelectContent>
                {labels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" /> Describe the purpose
            </Label>
            <Textarea
              className="mt-1.5"
              rows={2}
              placeholder='e.g. "An invitation folder for Google Meet, Zoom, and similar meeting invitations"'
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Say what kind of email belongs here, then let AI write the rule below.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={generateRule}
                disabled={generatingRule || !purpose.trim()}
              >
                {generatingRule ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Generating…
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Generate rule
                  </>
                )}
              </Button>
            </div>
          </div>

          <div className="mt-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              AI rule (natural language)
            </Label>
            <Textarea
              className="mt-1.5"
              rows={2}
              placeholder='e.g. "Newsletters, marketing emails"'
              value={local.ai_rule ?? ""}
              onChange={(e) => setLocal({ ...local, ai_rule: e.target.value })}
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={draftFromLabel}
                disabled={draftingFromLabel || !folder.gmail_label_id}
                title={
                  folder.gmail_label_id
                    ? "Let AI read this label's emails and draft the instructions"
                    : "Link a Gmail label and save first"
                }
              >
                {draftingFromLabel ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Drafting…
                  </>
                ) : (
                  <>
                    <Tag className="mr-1.5 h-3.5 w-3.5" /> Draft from label
                  </>
                )}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTab("chat")}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Write with AI chat
              </Button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Draft from the linked label's emails, or open the AI chat to write and refine these
              instructions in conversation.
            </p>
          </div>

          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" /> Learned profile
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={syncLabel}
                  disabled={syncingLabel || !folder.gmail_label_id}
                  title="Apply this folder's Gmail label to all emails Zerrow has routed here"
                >
                  {syncingLabel ? "Syncing…" : "Sync to Gmail"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={learn}
                  disabled={learning || !folder.gmail_label_id}
                >
                  {learning
                    ? "Learning…"
                    : folder.last_learned_at
                      ? "Re-learn"
                      : "Learn from existing emails"}
                </Button>
              </div>
            </div>
            <p className="mt-2 text-sm text-foreground/80">
              {folder.learned_profile || (
                <span className="text-muted-foreground italic">
                  Not learned yet.{" "}
                  {linkedLabel
                    ? `Linked to "${linkedLabel.name}".`
                    : "Link a Gmail label and save first."}
                </span>
              )}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {exampleCount} example{exampleCount === 1 ? "" : "s"}
              {folder.last_learned_at &&
                ` · learned ${new Date(folder.last_learned_at).toLocaleString()}`}
              {" · "}auto-updates as you move emails in Gmail
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={!!local.auto_relearn}
                  onCheckedChange={async (v) => {
                    setLocal({ ...local, auto_relearn: v });
                    try {
                      await setAutoRelearnFn({ data: { folder_id: folder.id, auto_relearn: v } });
                      toast.success(v ? "Auto-learning on" : "Auto-learning off");
                      qc.invalidateQueries({ queryKey: ["folders-full"] });
                    } catch (e: unknown) {
                      setLocal({ ...local, auto_relearn: !v });
                      toast.error(e instanceof Error ? e.message : "Failed to update");
                    }
                  }}
                />
                <Label className="text-sm">Keep learning automatically</Label>
              </div>
              {local.auto_relearn && (
                <span className="text-xs text-muted-foreground">
                  Re-learns after {folder.relearn_threshold ?? 25} new emails ·{" "}
                  {folder.emails_since_learn ?? 0} new since last learn
                </span>
              )}
            </div>
            {(domainsQ.data?.length ?? 0) > 0 && (
              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1.5">
                  Suggested domains
                </div>
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
                      <Popover
                        open={pickerOpen === s.domain}
                        onOpenChange={(o) => setPickerOpen(o ? s.domain : null)}
                      >
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
                            <div className="px-2 py-2 text-xs text-muted-foreground italic">
                              No other folders
                            </div>
                          ) : (
                            <div className="max-h-64 overflow-y-auto">
                              {(otherFoldersQ.data ?? []).map((f) => (
                                <button
                                  key={f.id}
                                  onClick={() => reassignDomain(s.domain, f.id, f.name)}
                                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent text-left"
                                >
                                  <span
                                    className="h-2.5 w-2.5 rounded-full"
                                    style={{ background: f.color }}
                                  />
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

          <label
            className="mt-4 flex items-center justify-between rounded-md border border-border p-3 text-sm"
            title="Only use the rules — never let AI assign emails to this folder"
          >
            <div>
              Rules only
              <span className="ml-2 text-xs text-muted-foreground">
                (skip AI fallback for this folder)
              </span>
            </div>
            <Switch
              checked={local.skip_ai ?? false}
              onCheckedChange={(v) => toggleBehavior("skip_ai", v, null)}
            />
          </label>
        </TabsContent>

        <TabsContent value="automation" className="mt-4">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-foreground">
            <Inbox className="h-3.5 w-3.5" /> Automation
          </div>
          <p className="mb-3 mt-1 text-xs text-muted-foreground">
            Choose what happens to mail once it lands in this folder.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              Auto-archive
              <Switch
                checked={local.auto_archive}
                onCheckedChange={(v) => toggleBehavior("auto_archive", v, "archive")}
              />
            </label>
            <label className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
              Auto mark-read
              <Switch
                checked={local.auto_mark_read}
                onCheckedChange={(v) => toggleBehavior("auto_mark_read", v, "mark_read")}
              />
            </label>
            <label
              className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
              title="Star matching emails (also stars them in Gmail)"
            >
              Auto-star
              <Switch
                checked={local.auto_star ?? false}
                onCheckedChange={(v) => toggleBehavior("auto_star", v, "star")}
              />
            </label>
            <label
              className="flex items-center justify-between rounded-md border border-border p-3 text-sm"
              title="Hide from main Inbox view (still visible inside this folder)"
            >
              Hide from Inbox
              <Switch
                checked={local.hide_from_inbox ?? false}
                onCheckedChange={(v) => toggleBehavior("hide_from_inbox", v, "archive")}
              />
            </label>
          </div>

          <div className="mt-6">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              aria-expanded={showAdvanced}
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
              />
              Advanced
            </button>

            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <label
                  className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm"
                  title="When this folder's filters match, route the email here even if the sender is on your Always-send-to-inbox list"
                >
                  <div className="min-w-0">
                    Beat "Always send to inbox" rules
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      When this folder's filters match, route here even if the sender is on your
                      inbox list.
                    </p>
                  </div>
                  <Switch
                    checked={local.overrides_inbox_override ?? false}
                    onCheckedChange={(v) => toggleBehavior("overrides_inbox_override", v, null)}
                  />
                </label>
                <label
                  className="flex items-start justify-between gap-3 rounded-md border border-border p-3 text-sm"
                  title="When the calendar guard is on, people you've met in Google Calendar are never filed into this folder"
                >
                  <div className="min-w-0">
                    Cold email folder
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      With the calendar guard on, people you've met in Google Calendar are kept in
                      the inbox instead of landing here.
                    </p>
                  </div>
                  <Switch
                    checked={local.is_cold_email ?? false}
                    onCheckedChange={(v) => toggleBehavior("is_cold_email", v, null)}
                  />
                </label>

                <div className="rounded-md border border-border p-3">
                  <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
                    <Inbox className="h-3 w-3" /> Surface to inbox (AI)
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Rules file mail here as usual, but let AI keep the ones meant for you visible in
                    the inbox (still filed in this folder). Leave blank to turn off.
                  </p>
                  <Textarea
                    className="mt-2"
                    rows={2}
                    placeholder="e.g. Keep it in my inbox when it's addressed specifically to me and mentions my name, or needs a personal reply."
                    value={local.surface_ai_rule ?? ""}
                    onChange={(e) => setLocal({ ...local, surface_ai_rule: e.target.value })}
                  />
                  <Label className="mt-3 block text-xs uppercase tracking-wider text-muted-foreground">
                    Names / aliases (optional)
                  </Label>
                  <Input
                    className="mt-1.5"
                    placeholder="e.g. Jane Doe, JD, jane"
                    value={local.surface_names ?? ""}
                    onChange={(e) => setLocal({ ...local, surface_names: e.target.value })}
                  />
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Matched alongside your connected Gmail address to recognize mail addressed to
                    you.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-md border border-border p-3 text-sm">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Auto-forward to
                    </Label>
                    <Input
                      className="mt-1.5 h-8"
                      type="email"
                      placeholder="someone@example.com"
                      value={local.forward_to ?? ""}
                      onChange={(e) => setLocal({ ...local, forward_to: e.target.value })}
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Forwards each matching email once, on arrival.
                    </p>
                  </div>
                  <div className="rounded-md border border-border p-3 text-sm">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Snooze on arrival (hours)
                    </Label>
                    <Input
                      className="mt-1.5 h-8"
                      type="number"
                      min={0}
                      max={720}
                      value={local.snooze_hours ?? 0}
                      onChange={(e) =>
                        setLocal({ ...local, snooze_hours: parseInt(e.target.value) || 0 })
                      }
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Hides matched emails until the snooze expires.
                    </p>
                  </div>
                  <div className="rounded-md border border-border p-3 text-sm">
                    <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                      Min AI confidence (%)
                    </Label>
                    <Input
                      className="mt-1.5 h-8"
                      type="number"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round((local.min_ai_confidence ?? 0) * 100)}
                      onChange={(e) =>
                        setLocal({
                          ...local,
                          min_ai_confidence: (parseInt(e.target.value) || 0) / 100,
                        })
                      }
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Reject AI assignment below this confidence.
                    </p>
                  </div>
                </div>

                <ScanGmailSection
                  folder={local}
                  hasIncludeRules={
                    filters.some(
                      (f) =>
                        f.op !== "not_contains" && f.op !== "not_equals" && f.op !== "domain_in",
                    ) || !!local.filter_tree
                  }
                />
              </div>
            )}
          </div>
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

        <TabsContent value="chat" className="mt-4">
          <FolderChatPanel
            folder={local}
            onApplied={(patch) => setLocal((p) => ({ ...p, ...patch }))}
          />
        </TabsContent>
      </Tabs>

      {dirty && (
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setLocal(folder)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}
