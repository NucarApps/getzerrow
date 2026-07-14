import { useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listFolderHistory,
  suggestRecategorization,
  applyRecategorization,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Bot,
  Hand,
  Filter as FilterIcon,
  Tag,
  Inbox,
  Loader2,
  ChevronDown,
  MoveRight,
} from "lucide-react";
import { toast } from "sonner";
import type { Folder, Filter, HistoryEmail } from "./types";

type ReasonTone = "ai" | "manual" | "rule" | "label" | "muted";
const reasonMeta: Record<string, { label: string; tone: ReasonTone; Icon: typeof Bot }> = {
  ai: { label: "AI", tone: "ai", Icon: Bot },
  manual_move: { label: "Manual", tone: "manual", Icon: Hand },
  filter: { label: "Rule", tone: "rule", Icon: FilterIcon },
  domain_rule: { label: "Domain rule", tone: "rule", Icon: FilterIcon },
  gmail_label: { label: "Gmail label", tone: "label", Icon: Tag },
  surfaced_to_inbox: { label: "Surfaced", tone: "label", Icon: Inbox },
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

type SuggestionResult = Awaited<
  ReturnType<ReturnType<typeof useServerFn<typeof suggestRecategorization>>>
>;

export function HistoryPanel({
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
      const r = await historyFn({
        data: { folder_id: folder.id, limit: PAGE * pageCount, offset: 0 },
      });
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
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to get suggestion");
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
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to apply");
    } finally {
      setApplying(false);
    }
  }

  if (historyQ.isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
      </div>
    );
  }
  const emails = historyQ.data?.emails ?? [];
  const hasMore = historyQ.data?.has_more ?? false;
  if (emails.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No emails have been processed into this folder yet.
      </div>
    );
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
                if (isOpen && isActive) {
                  setActiveEmail(null);
                  setSuggestion(null);
                }
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
              <span
                className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass[meta.tone]}`}
              >
                <ReasonIcon className="h-3 w-3" />
                {meta.label}
                {e.classified_by === "ai" && conf != null ? ` ${conf}%` : ""}
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
              />
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
                    <Popover
                      open={pickerFor === e.id}
                      onOpenChange={(o) => setPickerFor(o ? e.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <Button size="sm" variant="outline">
                          <MoveRight className="mr-1.5 h-3.5 w-3.5" /> Move to…
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-60 p-1" align="start">
                        <div className="px-2 py-1.5 text-xs text-muted-foreground">
                          Should go to…
                        </div>
                        {otherFolders.length === 0 ? (
                          <div className="px-2 py-2 text-xs text-muted-foreground italic">
                            No other folders
                          </div>
                        ) : (
                          <div className="max-h-64 overflow-y-auto">
                            {otherFolders.map((f) => (
                              <button
                                key={f.id}
                                onClick={() => startSuggestion(e.id, f.id)}
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
                    <span className="text-xs text-muted-foreground">
                      Wrong folder? Pick where it belongs.
                    </span>
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
                          Move 1 email ·{" "}
                          <span className="font-medium text-foreground">
                            {suggestion.source.name}
                          </span>
                          {" → "}
                          <span className="font-medium text-foreground">
                            {suggestion.target.name}
                          </span>
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
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setActiveEmail(null);
                              setSuggestion(null);
                            }}
                            disabled={applying}
                          >
                            Cancel
                          </Button>
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
            {historyQ.isFetching ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Loading…
              </>
            ) : (
              "Load more"
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function ReasonBlock({
  email,
  folderName,
  filters,
}: {
  email: HistoryEmail;
  folderName: string;
  filters: Filter[];
}) {
  const by = email.classified_by ?? "none";
  const meta = getReasonMeta(by);
  const Icon = meta.Icon;

  let title: string;
  let body: ReactNode;

  if (by === "ai") {
    const conf = email.ai_confidence != null ? Math.round(email.ai_confidence * 100) : null;
    title = `Classified by AI${conf != null ? ` · ${conf}% confidence` : ""}`;
    body = email.ai_summary ? (
      <blockquote className="border-l-2 border-indigo-500/40 pl-3 italic text-foreground/80">
        "{email.ai_summary}"
      </blockquote>
    ) : (
      <span className="text-muted-foreground italic">No reason recorded.</span>
    );
  } else if (by === "manual_move") {
    title = "Moved here manually";
    body = (
      <span className="text-muted-foreground">
        You (or a connected Gmail action) moved this email into{" "}
        <span className="font-medium text-foreground">{folderName}</span>.
      </span>
    );
  } else if (by === "filter" || by === "domain_rule") {
    const matched = matchFilter(email, filters);
    title = by === "domain_rule" ? "Matched a domain rule" : "Matched a folder rule";
    body = matched ? (
      <span>
        Matched{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">
          {matched.field} {matched.op} "{matched.value}"
        </code>
      </span>
    ) : (
      <span className="text-muted-foreground">Matched one of this folder's rules.</span>
    );
  } else if (by === "gmail_label") {
    title = "Imported from Gmail label";
    body = (
      <span className="text-muted-foreground">
        This email already had the matching Gmail label when it was synced.
      </span>
    );
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
        case "from":
          return (email.from_addr || "") + " " + (email.from_name || "");
        case "subject":
          return email.subject || "";
        case "snippet":
        case "body":
          return email.snippet || "";
        default:
          return "";
      }
    })().toLowerCase();
    const op = f.op || "contains";
    const hit =
      op === "equals"
        ? target === value
        : op === "starts_with"
          ? target.startsWith(value)
          : op === "ends_with"
            ? target.endsWith(value)
            : target.includes(value);
    if (hit) return f;
  }
  return null;
}

function RulePatchCard({
  title,
  current,
  proposed,
  why,
  checked,
  onChange,
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
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={checked} onCheckedChange={(v) => onChange(!!v)} disabled={!changed} />
          Update rule
        </label>
      </div>
      <div className="mt-2 space-y-2 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Current</div>
          <div className="text-foreground/80">
            {current || <span className="italic text-muted-foreground">(empty)</span>}
          </div>
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
