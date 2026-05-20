import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  triggerSync, markEmailRead, archiveEmail, trashEmail, generateReply, sendReply,
  moveEmailToFolder, reanalyzeEmail, moveEmailToInbox,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sparkles, Archive, Trash2, RefreshCw, Mail, MailOpen, Send, Inbox, ChevronLeft, FolderInput, ChevronDown, Bot, Filter as FilterIcon, Tag, Hand, HelpCircle, Search, X, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useFolderSelection } from "@/lib/folder-selection";
import { MoveSimilarDialog } from "@/components/emails/MoveSimilarDialog";
import { AlwaysInboxDialog } from "@/components/emails/AlwaysInboxDialog";


export const Route = createFileRoute("/_authenticated/")({ component: InboxPage });

type Email = {
  id: string;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  is_read: boolean;
  is_archived: boolean;
  folder_id: string | null;
  ai_summary: string | null;
  ai_confidence: number | null;
  thread_id: string | null;
  classified_by: string | null;
  classification_reason: string | null;
  matched_filter_ids: string[] | null;
  to_addrs: string | null;
  has_attachment: boolean;
};

type Folder = { id: string; name: string; color: string };

function InboxPage() {
  const qc = useQueryClient();
  const sync = useServerFn(triggerSync);
  const { selected: selectedFolder } = useFolderSelection();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const accountQ = useQuery({
    queryKey: ["gmail_account"],
    queryFn: async () => {
      const { data } = await supabase.from("gmail_accounts").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
      return data as { id: string } | null;
    },
  });
  const accountId = accountQ.data?.id ?? null;

  const foldersQ = useQuery({
    queryKey: ["folders"],
    queryFn: async () => {
      const { data } = await supabase.from("folders").select("id,name,color").order("priority", { ascending: false });
      return (data ?? []) as Folder[];
    },
  });

  const emailsQ = useQuery({
    queryKey: ["emails"],
    queryFn: async () => {
      // Include archived rows so folder views can show labeled mail that isn't in INBOX.
      // The All inbox / Unsorted views filter is_archived in-memory below.
      const { data } = await supabase.from("emails").select("*").order("received_at", { ascending: false }).limit(2000);
      return (data ?? []) as Email[];
    },
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });


  const filtered = useMemo(() => {
    const all = emailsQ.data ?? [];
    let scoped: Email[];
    if (selectedFolder === "all") scoped = all.filter((e) => !e.is_archived);
    else if (selectedFolder === "unsorted") scoped = all.filter((e) => !e.is_archived && !e.folder_id);
    else scoped = all.filter((e) => e.folder_id === selectedFolder);
    const q = query.trim().toLowerCase();
    if (!q) return scoped;
    return scoped.filter((e) => {
      return (
        (e.from_name && e.from_name.toLowerCase().includes(q)) ||
        (e.from_addr && e.from_addr.toLowerCase().includes(q)) ||
        (e.subject && e.subject.toLowerCase().includes(q)) ||
        (e.snippet && e.snippet.toLowerCase().includes(q))
      );
    });
  }, [emailsQ.data, selectedFolder, query]);

  const selected = filtered.find((e) => e.id === selectedId) ?? null;

  const syncMut = useMutation({
    mutationFn: () => {
      if (!accountId) throw new Error("Connect Gmail in Settings first");
      return sync({ data: { account_id: accountId } });
    },
    onSuccess: async (res: any) => {
      const r = res?.reconciled;
      const parts: string[] = [];
      if (typeof res?.synced === "number" && res.synced > 0) parts.push(`${res.synced} new`);
      if (r?.archived) parts.push(`${r.archived} archived`);
      if (r?.deleted) parts.push(`${r.deleted} removed`);
      if (r?.failed) parts.push(`${r.failed} failed`);
      const msg = parts.length ? `Synced · ${parts.join(", ")}` : "Synced";
      if (res?.error) toast.error(`Sync error: ${res.error}`);
      else toast.success(msg);
      await Promise.all([
        qc.refetchQueries({ queryKey: ["emails"] }),
        qc.invalidateQueries({ queryKey: ["gmail-accounts"] }),
      ]);
      const fresh = qc.getQueryData<Email[]>(["emails"]) ?? [];
      if (selectedId && !fresh.some((e) => e.id === selectedId)) setSelectedId(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const headerLabel = labelForFolder(selectedFolder, foldersQ.data ?? []);

  return (
    <div className="grid h-full md:grid-cols-[400px_1fr]">
      {/* List */}
      <div className={`h-full flex-col overflow-hidden border-r border-border ${selected ? "hidden md:flex" : "flex"}`}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="truncate font-display text-xl">{headerLabel}</h2>
            <span className="shrink-0 text-xs text-muted-foreground">{filtered.length}</span>
          </div>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => syncMut.mutate()} disabled={syncMut.isPending} title="Refresh">
            <RefreshCw className={`h-4 w-4 ${syncMut.isPending ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="border-b border-border px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, email, or subject"
              className="h-8 pl-8 pr-8 text-sm"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {emailsQ.isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
          {!emailsQ.isLoading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 p-12 text-center text-muted-foreground">
              <Inbox className="h-8 w-8 opacity-40" />
              <p className="text-sm">Nothing here yet.</p>
              <p className="text-xs">Hit refresh, or connect Gmail in Settings.</p>
            </div>
          )}
          {filtered.map((e) => (
            <button
              key={e.id}
              onClick={() => setSelectedId(e.id)}
              className={`block w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-accent/50 ${selectedId === e.id ? "bg-accent" : ""} ${e.is_read ? "opacity-70" : ""}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={`truncate text-sm ${e.is_read ? "" : "font-semibold"}`}>{e.from_name || e.from_addr || "Unknown"}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {e.received_at ? formatDistanceToNow(new Date(e.received_at), { addSuffix: false }) : ""}
                </span>
              </div>
              <div className="truncate text-sm text-foreground/90">{e.subject || "(no subject)"}</div>
              {e.ai_summary ? (
                <div className="mt-1 flex items-start gap-1.5 text-xs text-primary/90">
                  <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="line-clamp-2">{e.ai_summary}</span>
                </div>
              ) : (
                <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{e.snippet}</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Reading pane */}
      <div className={`h-full overflow-y-auto ${selected ? "block" : "hidden md:block"}`}>
        {selected ? <Reader key={selected.id} email={selected} folders={foldersQ.data ?? []} onBack={() => setSelectedId(null)} /> : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p className="text-sm">Select an email</p>
          </div>
        )}
      </div>
    </div>
  );
}

function labelForFolder(sel: string | "all" | "unsorted", folders: Folder[]) {
  if (sel === "all") return "All inbox";
  if (sel === "unsorted") return "Unsorted";
  return folders.find((f) => f.id === sel)?.name ?? "Folder";
}

function Reader({ email, folders, onBack }: { email: Email; folders: Folder[]; onBack?: () => void }) {
  const qc = useQueryClient();
  const markFn = useServerFn(markEmailRead);
  const archFn = useServerFn(archiveEmail);
  const trashFn = useServerFn(trashEmail);
  const genFn = useServerFn(generateReply);
  const sendFn = useServerFn(sendReply);
  const moveFn = useServerFn(moveEmailToFolder);
  const reanalyzeFn = useServerFn(reanalyzeEmail);
  const inboxFn = useServerFn(moveEmailToInbox);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [alwaysInbox, setAlwaysInbox] = useState<null | { fromAddr: string | null; domain: string | null }>(null);
  const [reply, setReply] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [moving, setMoving] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [similarPrompt, setSimilarPrompt] = useState<null | {
    fromFolderId: string | null;
    fromAddr: string | null;
    domain: string | null;
    toFolder: Folder;
  }>(null);

  const folderRulesQ = useQuery({
    queryKey: ["folder-rules", email.folder_id],
    enabled: !!email.folder_id,
    queryFn: async () => {
      const [folderRes, filtersRes] = await Promise.all([
        supabase.from("folders").select("id, name, ai_rule, gmail_label_id").eq("id", email.folder_id!).maybeSingle(),
        supabase.from("folder_filters").select("id, field, op, value").eq("folder_id", email.folder_id!),
      ]);
      return {
        folder: folderRes.data as { id: string; name: string; ai_rule: string | null; gmail_label_id: string | null } | null,
        filters: (filtersRes.data ?? []) as Array<{ id: string; field: string; op: string; value: string }>,
      };
    },
  });

  useEffect(() => {
    if (email.is_read) return;
    qc.setQueryData<Email[]>(["emails"], (prev) =>
      prev?.map((e) => (e.id === email.id ? { ...e, is_read: true } : e)),
    );
    markFn({ data: { id: email.id, read: true } }).catch(() =>
      qc.invalidateQueries({ queryKey: ["emails"] }),
    );
  }, [email.id]); // eslint-disable-line

  const folder = folders.find((f) => f.id === email.folder_id);
  const otherFolders = folders.filter((f) => f.id !== email.folder_id);

  async function moveTo(target: Folder) {
    setMoving(true);
    // Optimistic: flip folder_id locally so the row jumps immediately.
    qc.setQueryData<Email[]>(["emails"], (prev) =>
      prev?.map((e) => (e.id === email.id ? { ...e, folder_id: target.id } : e)),
    );
    try {
      const r = await moveFn({ data: { email_id: email.id, to_folder_id: target.id } });
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["emails-summary"] });
      toast.success(`Moved to ${target.name}`);
      setSimilarPrompt({
        fromFolderId: r.from_folder_id,
        fromAddr: r.from_addr,
        domain: r.domain,
        toFolder: target,
      });
    } catch (e: any) {
      qc.invalidateQueries({ queryKey: ["emails"] });
      toast.error(e.message);
    } finally {
      setMoving(false);
    }
  }


  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && (
            <button onClick={onBack} className="grid h-8 w-8 place-items-center rounded-md hover:bg-accent md:hidden" aria-label="Back">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {folder && <Badge variant="outline" className="gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: folder.color }} />{folder.name}</Badge>}
          {email.ai_confidence != null && email.ai_summary && (
            <Badge variant="outline" className="gap-1 text-xs"><Sparkles className="h-3 w-3" />AI · {Math.round(email.ai_confidence * 100)}%</Badge>
          )}
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={reanalyzing}
            title="Re-analyze with current folders & rules"
            onClick={async () => {
              setReanalyzing(true);
              try {
                const r = await reanalyzeFn({ data: { email_id: email.id } });
                qc.invalidateQueries({ queryKey: ["emails"] });
                qc.invalidateQueries({ queryKey: ["emails-summary"] });
                if (!r.changed) {
                  toast.success("Re-analyzed — no change");
                } else if (r.folder_id && r.folder_name) {
                  toast.success(`Re-analyzed → ${r.folder_name}`);
                } else {
                  toast.success("Re-analyzed → Inbox");
                }
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setReanalyzing(false);
              }
            }}
          >
            <RotateCw className={`h-4 w-4 ${reanalyzing ? "animate-spin" : ""}`} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={moving} title="Move to folder">
                <FolderInput className="h-4 w-4" />
                <ChevronDown className="ml-0.5 h-3 w-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Move to</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {email.folder_id && (
                <>
                  <DropdownMenuItem
                    onSelect={async () => {
                      setMoving(true);
                      qc.setQueryData<Email[]>(["emails"], (prev) =>
                        prev?.map((e) => (e.id === email.id ? { ...e, folder_id: null, is_archived: false } : e)),
                      );
                      try {
                        const r = await inboxFn({ data: { email_id: email.id, add_override: null } });
                        qc.invalidateQueries({ queryKey: ["emails"] });
                        qc.invalidateQueries({ queryKey: ["emails-summary"] });
                        toast.success("Moved to Inbox");
                        if (r.from_addr || r.domain) {
                          setAlwaysInbox({ fromAddr: r.from_addr, domain: r.domain });
                        }
                      } catch (e: any) {
                        qc.invalidateQueries({ queryKey: ["emails"] });
                        toast.error(e.message);
                      } finally {
                        setMoving(false);
                      }
                    }}
                  >
                    <Inbox className="mr-2 h-4 w-4" />
                    Inbox (no folder)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              {otherFolders.map((f) => (
                <DropdownMenuItem key={f.id} onSelect={() => moveTo(f)}>
                  <span className="mr-2 h-2.5 w-2.5 rounded-full" style={{ background: f.color }} />
                  {f.name}
                </DropdownMenuItem>
              ))}
              {otherFolders.length === 0 && !email.folder_id && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">No other folders</div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={() => {
            const next = !email.is_read;
            qc.setQueryData<Email[]>(["emails"], (prev) => prev?.map((e) => (e.id === email.id ? { ...e, is_read: next } : e)));
            markFn({ data: { id: email.id, read: next } }).catch(() => qc.invalidateQueries({ queryKey: ["emails"] }));
          }}>
            {email.is_read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={async () => {
            qc.setQueryData<Email[]>(["emails"], (prev) => prev?.map((e) => (e.id === email.id ? { ...e, is_archived: true } : e)));
            try { await archFn({ data: { id: email.id } }); toast.success("Archived"); }
            catch (e: any) { qc.invalidateQueries({ queryKey: ["emails"] }); toast.error(e.message); }
          }}>
            <Archive className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={async () => {
            qc.setQueryData<Email[]>(["emails"], (prev) => prev?.filter((e) => e.id !== email.id));
            try { await trashFn({ data: { id: email.id } }); toast.success("Trashed"); }
            catch (e: any) { qc.invalidateQueries({ queryKey: ["emails"] }); toast.error(e.message); }
          }}>
            <Trash2 className="h-4 w-4" />
          </Button>

        </div>

      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <h1 className="font-display text-2xl leading-tight md:text-3xl">{email.subject || "(no subject)"}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          <strong className="text-foreground">{email.from_name || email.from_addr}</strong>
          {email.from_name && email.from_addr ? ` <${email.from_addr}>` : ""}
          {email.received_at && ` · ${new Date(email.received_at).toLocaleString()}`}
        </p>
        {email.ai_summary && (
          <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
            <div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-wider text-primary"><Sparkles className="h-3 w-3" />Summary</div>
            {email.ai_summary}
          </div>
        )}

        <Collapsible open={whyOpen} onOpenChange={setWhyOpen} className="mt-3">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between rounded-md border border-border bg-card/30 px-3 py-2 text-left text-sm hover:bg-accent/40">
              <span className="flex items-center gap-2">
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Why this folder?</span>
                <ClassifiedChip by={email.classified_by} />
              </span>
              <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${whyOpen ? "rotate-180" : ""}`} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-3 rounded-md border border-border bg-card/30 p-3 text-sm">
            <TriggeredBy
              classifiedBy={email.classified_by}
              reason={email.classification_reason}
              folder={folderRulesQ.data?.folder ?? null}
              filters={folderRulesQ.data?.filters ?? []}
              email={email}
            />
            {email.classified_by === "ai" && email.ai_confidence != null && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">AI confidence</div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${Math.round(email.ai_confidence * 100)}%` }} />
                </div>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        <div className="mt-6">
          {email.body_html ? (
            <div
              className="rounded-lg bg-white p-4 text-sm leading-relaxed text-neutral-900 [&_*]:max-w-full [&_a]:text-blue-600 [&_img]:h-auto [&_img]:max-w-full"
              style={{ colorScheme: "light" }}
              dangerouslySetInnerHTML={{ __html: email.body_html }}
            />
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">{email.body_text}</pre>
          )}
        </div>
      </div>

      <div className="border-t border-border bg-card/30 p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-widest text-muted-foreground">Reply</span>
          <Button size="sm" variant="ghost" disabled={generating}
            onClick={async () => {
              setGenerating(true);
              try { const r = await genFn({ data: { id: email.id } }); setReply(r.draft); } catch (e: any) { toast.error(e.message); }
              setGenerating(false);
            }}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />{generating ? "Drafting…" : "Suggest reply"}
          </Button>
        </div>
        <Textarea rows={4} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" />
        <div className="mt-2 flex justify-end">
          <Button size="sm" disabled={!reply.trim() || sending}
            onClick={async () => {
              setSending(true);
              try { await sendFn({ data: { id: email.id, body: reply } }); toast.success("Sent"); setReply(""); } catch (e: any) { toast.error(e.message); }
              setSending(false);
            }}>
            <Send className="mr-1.5 h-3.5 w-3.5" />Send
          </Button>
        </div>
      </div>

      {similarPrompt && (
        <MoveSimilarDialog
          open={!!similarPrompt}
          onOpenChange={(v) => { if (!v) setSimilarPrompt(null); }}
          emailId={email.id}
          fromFolderId={similarPrompt.fromFolderId}
          fromAddr={similarPrompt.fromAddr}
          domain={similarPrompt.domain}
          toFolder={similarPrompt.toFolder}
          folders={folders}
        />
      )}
    </div>
  );
}

function ClassifiedChip({ by }: { by: string | null }) {
  const map: Record<string, { label: string; Icon: typeof Bot; cls: string }> = {
    ai: { label: "AI", Icon: Bot, cls: "text-primary" },
    filter: { label: "Rule", Icon: FilterIcon, cls: "text-foreground" },
    gmail_label: { label: "Gmail label", Icon: Tag, cls: "text-foreground" },
    domain_rule: { label: "Rule", Icon: FilterIcon, cls: "text-foreground" },
    manual_move: { label: "Manual", Icon: Hand, cls: "text-foreground" },
    excluded: { label: "Excluded", Icon: HelpCircle, cls: "text-destructive" },
    global_exclude: { label: "Inbox list", Icon: HelpCircle, cls: "text-destructive" },
    none: { label: "Unclassified", Icon: HelpCircle, cls: "text-muted-foreground" },
  };
  const k = by ?? "none";
  const v = map[k] ?? map.none;
  const { Icon } = v;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${v.cls}`}>
      <Icon className="h-3 w-3" /> {v.label}
    </span>
  );
}

function opLabel(op: string) {
  const m: Record<string, string> = {
    contains: "contains", equals: "equals", starts_with: "starts with",
    ends_with: "ends with", regex: "matches regex",
    not_contains: "does not contain", not_equals: "does not equal",
  };
  return m[op] ?? op;
}

// Mirror of applyFilter in src/lib/sync.server.ts — keep in sync.
function applyFilterClient(
  email: { from_addr: string | null; from_name: string | null; to_addrs: string | null; subject: string | null; body_text: string | null; has_attachment: boolean },
  f: { field: string; op: string; value: string },
): boolean {
  const v = (f.value || "").toLowerCase();
  const fieldVal = (() => {
    switch (f.field) {
      case "from": return `${email.from_addr ?? ""} ${email.from_name ?? ""}`.toLowerCase();
      case "to": return (email.to_addrs ?? "").toLowerCase();
      case "subject": return (email.subject ?? "").toLowerCase();
      case "body": return (email.body_text ?? "").toLowerCase();
      case "domain": return ((email.from_addr ?? "").split("@")[1] ?? "").toLowerCase();
      case "has_attachment": return email.has_attachment ? "true" : "false";
      default: return "";
    }
  })();
  switch (f.op) {
    case "contains": return fieldVal.includes(v);
    case "equals": return fieldVal === v;
    case "not_contains": return !fieldVal.includes(v);
    case "not_equals": return fieldVal !== v;
    case "regex":
      try { return new RegExp(f.value, "i").test(fieldVal); } catch { return false; }
    default: return false;
  }
}

const EXCLUDE_OPS_CLIENT = new Set(["not_contains", "not_equals"]);

function TriggeredBy({
  classifiedBy, reason, folder, filters, email,
}: {
  classifiedBy: string | null;
  reason: string | null;
  folder: { id: string; name: string; ai_rule: string | null; gmail_label_id: string | null } | null;
  filters: Array<{ id: string; field: string; op: string; value: string }>;
  email: Email;
}) {
  const by = classifiedBy ?? "none";

  const { matched, rulesChanged } = useMemo(() => {
    if (by !== "filter" && by !== "domain_rule") return { matched: [], rulesChanged: false };
    const persisted = email.matched_filter_ids ?? [];
    if (persisted.length > 0) {
      const byId = new Map(filters.map((f) => [f.id, f]));
      const hits = persisted.map((id) => byId.get(id)).filter(Boolean) as typeof filters;
      if (hits.length > 0) return { matched: hits, rulesChanged: false };
      // Persisted ids exist but rules have since been removed/edited.
      return { matched: [], rulesChanged: true };
    }
    // Legacy email: recompute the matching includes client-side.
    const includes = filters.filter((f) => !EXCLUDE_OPS_CLIENT.has(f.op));
    return { matched: includes.filter((f) => applyFilterClient(email, f)), rulesChanged: false };
  }, [by, email, filters]);

  if (by === "filter" || by === "domain_rule") {
    const showAllFallback = matched.length === 0 && filters.length > 0;
    const list = matched.length > 0 ? matched : filters;
    return (
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {matched.length > 1 ? "Rules that matched" : "Rule that matched"}
        </div>
        {reason && <p className="text-foreground/90">{reason}</p>}
        {list.length > 0 && (
          <ul className="space-y-1">
            {list.map((f, i) => (
              <li key={i} className="rounded border border-border bg-background/40 px-2 py-1 font-mono text-xs">
                <span className="text-muted-foreground">{f.field}</span>{" "}
                <span className="text-primary">{opLabel(f.op)}</span>{" "}
                <span className="text-foreground">"{f.value}"</span>
              </li>
            ))}
          </ul>
        )}
        {showAllFallback && (
          <p className="text-xs italic text-muted-foreground">
            {rulesChanged
              ? "The rule that originally matched this email has since been removed or edited."
              : "Couldn't pinpoint the exact rule — showing all rules for this folder."}
          </p>
        )}
      </div>
    );
  }


  if (by === "ai") {
    return (
      <div className="space-y-2">
        {folder?.ai_rule && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">Folder AI prompt</div>
            <p className="rounded border border-border bg-background/40 px-2 py-1.5 text-foreground/90 italic">"{folder.ai_rule}"</p>
          </div>
        )}
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">Why the AI picked this folder</div>
          {reason ? (
            <p className="text-foreground/90">{reason}</p>
          ) : (
            <p className="italic text-muted-foreground">No reasoning recorded for this email. Newly synced emails will include one.</p>
          )}
        </div>
      </div>
    );
  }

  if (by === "gmail_label") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Gmail label</div>
        <p className="text-foreground/90">
          {reason ?? `Mapped from Gmail label${folder?.name ? ` to "${folder.name}"` : ""}.`}
        </p>
      </div>
    );
  }

  if (by === "manual_move") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">Moved manually</div>
        <p className="text-foreground/90">{reason ?? "You moved this email into the folder."}</p>
      </div>
    );
  }

  if (by === "excluded") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-destructive">Kept in inbox by exclude rule</div>
        <p className="text-foreground/90">{reason ?? "An exclude rule on a matching folder kept this email in your inbox."}</p>
      </div>
    );
  }

  if (by === "global_exclude") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-destructive">Always send to inbox</div>
        <p className="text-foreground/90">{reason ?? "This sender is on your global inbox list, so folder rules and AI sorting are skipped."}</p>
      </div>
    );
  }

  return (
    <p className="italic text-muted-foreground">
      This email hasn't been classified yet.
    </p>
  );
}
