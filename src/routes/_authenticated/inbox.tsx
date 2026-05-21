import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  triggerSync, markEmailRead, archiveEmail, trashEmail, generateReply, sendReply,
  moveEmailToFolder, reanalyzeEmail, moveEmailToInbox, addInboxOverride, stripFolderLabelPast,
  loadOlderFromGmail, searchGmailAndIngest, resyncMessage,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubTrigger, ContextMenuSubContent, ContextMenuSeparator, ContextMenuLabel,
} from "@/components/ui/context-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sparkles, Archive, Trash2, RefreshCw, Mail, MailOpen, Send, Inbox, ChevronLeft, FolderInput, ChevronDown, Bot, Filter as FilterIcon, Tag, Hand, HelpCircle, Search, X, RotateCw, AtSign, Globe, Reply } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useFolderSelection } from "@/lib/folder-selection";
import { MoveSimilarDialog } from "@/components/emails/MoveSimilarDialog";
import { AlwaysInboxDialog } from "@/components/emails/AlwaysInboxDialog";
import cobwebInbox from "@/assets/cobweb-inbox.svg";
import { TrackingStandby } from "@/components/inbox/TrackingStandby";


export const Route = createFileRoute("/_authenticated/inbox")({
  component: InboxPage,
  head: () => ({
    links: [{ rel: "stylesheet", href: "/zerrow-landing.css" }],
  }),
});

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};
function decodeEntities(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

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
  processed_at: string | null;
};

type Folder = { id: string; name: string; color: string; gmail_label_id: string | null };

const PAGE_SIZE = 50;

function EmailBodyFrame({ html }: { html: string }) {
  const ref = useMemo(() => ({ current: null as HTMLIFrameElement | null }), []);
  const srcDoc = `<!doctype html><html><head><base target="_blank"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;padding:16px;background:#fff;color:#111;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:break-word;}img{max-width:100%;height:auto;}a{color:#2563eb;}table{max-width:100%;}</style></head><body>${html}</body></html>`;
  const minPx = typeof window !== "undefined" ? Math.max(500, Math.round(window.innerHeight * 0.6)) : 600;
  const resize = () => {
    const f = ref.current;
    if (!f || !f.contentDocument) return;
    const h = f.contentDocument.documentElement.scrollHeight;
    f.style.height = Math.min(Math.max(h + 4, minPx), 4000) + "px";
  };
  return (
    <iframe
      ref={(el) => { ref.current = el; }}
      title="Email body"
      srcDoc={srcDoc}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      onLoad={() => {
        resize();
        const f = ref.current;
        if (!f || !f.contentDocument) return;
        const body = f.contentDocument.body;
        if (body && typeof ResizeObserver !== "undefined") {
          new ResizeObserver(resize).observe(body);
        }
        f.contentDocument.querySelectorAll("img").forEach((img) => {
          img.addEventListener("load", resize);
        });
      }}
      className="w-full rounded-lg bg-white"
      style={{ border: 0, colorScheme: "light", minHeight: minPx }}
    />
  );
}

function InboxPage() {
  const qc = useQueryClient();
  const sync = useServerFn(triggerSync);
  const moveFolderFn = useServerFn(moveEmailToFolder);
  const moveInboxFn = useServerFn(moveEmailToInbox);
  const addOverrideFn = useServerFn(addInboxOverride);
  const stripLabelFn = useServerFn(stripFolderLabelPast);
  const archFnList = useServerFn(archiveEmail);
  const trashFnList = useServerFn(trashEmail);
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
      const { data } = await supabase.from("folders").select("id,name,color,gmail_label_id").order("priority", { ascending: false });
      return (data ?? []) as Folder[];
    },
  });

  const isSearching = query.trim().length > 0;

  // Pagination state — reset to page 1 whenever the folder or search changes.
  // cursors[i] is the `received_at <` cursor used to fetch page i+1 (cursors[0] = null).
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  useEffect(() => {
    setPage(1);
    setCursors([null]);
    setSelectedId(null);
  }, [selectedFolder]);
  const cursor = cursors[page - 1] ?? null;

  const loadOlderFn = useServerFn(loadOlderFromGmail);

  const emailsQ = useQuery<Email[]>({
    queryKey: ["emails", selectedFolder, isSearching ? `search:${query.trim().toLowerCase()}` : `page:${page}:${cursor ?? "start"}`],
    queryFn: async () => {
      if (isSearching) {
        // Global search over the most recent messages, including archived/stripped.
        // Exclude body_text/body_html — they're only needed when an email is opened.
        const { data } = await supabase
          .from("emails")
          .select("id,from_addr,from_name,subject,snippet,received_at,is_read,is_archived,folder_id,ai_summary,ai_confidence,thread_id,classified_by,classification_reason,matched_filter_ids,to_addrs,has_attachment,processed_at")
          .order("received_at", { ascending: false })
          .limit(2000);
        return (data ?? []) as Email[];
      }
      const isNoRules = selectedFolder === "no_rules";
      const isAllMail = selectedFolder === "all_mail";
      let q = supabase
        .from("emails")
        .select("*")
        .order("received_at", { ascending: false, nullsFirst: false })
        .limit((isNoRules ? PAGE_SIZE * 3 : PAGE_SIZE) + 1);
      if (cursor) q = q.lt("received_at", cursor);
      if (isAllMail) {
        // no filter — show everything
      } else if (selectedFolder === "all") q = q.eq("is_archived", false);
      else if (isNoRules) q = q.is("folder_id", null);
      else q = q.eq("folder_id", selectedFolder);
      const { data } = await q;
      let rows = (data ?? []) as Email[];
      if (isNoRules) {
        rows = rows.filter((e) => !(e as any).raw_labels?.some((l: string) => l.startsWith("Label_")));
      }
      return rows;
    },
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  // When searching, also ask Gmail for matching messages and ingest any we
  // don't have locally — then refetch so they appear in the results.
  const searchGmailFn = useServerFn(searchGmailAndIngest);
  const [gmailSearching, setGmailSearching] = useState(false);
  useEffect(() => {
    const qstr = query.trim();
    if (qstr.length < 3) return;
    const handle = setTimeout(async () => {
      setGmailSearching(true);
      try {
        const r: any = await searchGmailFn({ data: { query: qstr } });
        if (r?.ingested > 0) {
          await qc.refetchQueries({ queryKey: ["emails"] });
          toast.success(`Pulled ${r.ingested} email${r.ingested === 1 ? "" : "s"} from Gmail.`);
        }
      } catch (e: any) {
        console.error("gmail search failed", e);
      } finally {
        setGmailSearching(false);
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [query, searchGmailFn, qc]);

  const rawEmails = emailsQ.data ?? [];
  const hasMoreLocal = !isSearching && rawEmails.length > PAGE_SIZE;
  const pageRows = isSearching ? rawEmails : rawEmails.slice(0, PAGE_SIZE);

  const filtered = useMemo(() => {
    if (isSearching) {
      const qstr = query.trim().toLowerCase();
      return pageRows.filter((e) => {
        return (
          (e.from_name && decodeEntities(e.from_name).toLowerCase().includes(qstr)) ||
          (e.from_addr && e.from_addr.toLowerCase().includes(qstr)) ||
          (e.subject && decodeEntities(e.subject).toLowerCase().includes(qstr)) ||
          (e.snippet && decodeEntities(e.snippet).toLowerCase().includes(qstr))
        );
      });
    }
    return pageRows;
  }, [pageRows, isSearching, query]);

  const currentFolderObj = (foldersQ.data ?? []).find((f) => f.id === selectedFolder) ?? null;
  const canPullFromGmail = !!currentFolderObj?.gmail_label_id;

  const pullOlderMut = useMutation({
    mutationFn: async () => {
      if (!currentFolderObj?.gmail_label_id) throw new Error("This view isn't linked to a Gmail label.");
      const lastReceived = pageRows[pageRows.length - 1]?.received_at ?? null;
      return loadOlderFn({ data: { folder_id: currentFolderObj.id, before_received_at: lastReceived } });
    },
    onSuccess: async (r: any) => {
      await qc.refetchQueries({ queryKey: ["emails", selectedFolder] });
      const pulled = (r?.ingested ?? 0) + (r?.claimed ?? 0);
      if (pulled > 0) toast.success(`Pulled ${pulled} older email${pulled === 1 ? "" : "s"} from Gmail.`);
      else toast.message("No older emails found in Gmail.");
      // Advance to next page using last row of CURRENT page as cursor.
      const lastReceived = pageRows[pageRows.length - 1]?.received_at ?? null;
      setCursors((prev) => {
        const next = prev.slice(0, page);
        next.push(lastReceived);
        return next;
      });
      setPage((p) => p + 1);
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to pull from Gmail"),
  });

  function goNext() {
    if (hasMoreLocal) {
      const lastReceived = pageRows[pageRows.length - 1]?.received_at ?? null;
      setCursors((prev) => {
        const next = prev.slice(0, page);
        next.push(lastReceived);
        return next;
      });
      setPage((p) => p + 1);
      return;
    }
    if (canPullFromGmail && !pullOlderMut.isPending) pullOlderMut.mutate();
  }
  function goPrev() {
    if (page > 1) setPage((p) => p - 1);
  }
  const canGoNext = !isSearching && (hasMoreLocal || canPullFromGmail);

  const selectedListItem = filtered.find((e) => e.id === selectedId) ?? null;

  // When searching, the list rows don't include body_text/body_html. Fetch the
  // full email on demand when one is selected so the detail pane can render it.
  const selectedFullQ = useQuery<Email | null>({
    queryKey: ["email-full", selectedId],
    enabled: !!selectedId && isSearching,
    queryFn: async () => {
      if (!selectedId) return null;
      const { data } = await supabase.from("emails").select("*").eq("id", selectedId).maybeSingle();
      return (data ?? null) as Email | null;
    },
  });
  const selected = isSearching && selectedFullQ.data ? selectedFullQ.data : selectedListItem;

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
      const fresh = qc.getQueriesData<Email[]>({ queryKey: ["emails"] }).flatMap(([,d]) => d ?? []) ?? [];
      if (selectedId && !fresh.some((e) => e.id === selectedId)) setSelectedId(null);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const headerLabel = labelForFolder(selectedFolder, foldersQ.data ?? []);

  return (
    <div className="grid h-full md:grid-cols-[400px_1fr]">
      {/* List */}
      <div className={`h-full flex-col overflow-hidden border-r border-border ${selected && selectedListItem ? "hidden md:flex" : "flex"}`}>
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
          {isSearching && (
            <div className="mt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {gmailSearching ? "Checking Gmail…" : "Searching all folders, including archived"}
            </div>
          )}
        </div>
        <div
          className="flex-1 overflow-y-auto"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}
        >
          {emailsQ.isLoading && <div className="p-6 text-sm text-muted-foreground">Loading…</div>}
          {!emailsQ.isLoading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center text-muted-foreground">
              <img src={cobwebInbox} alt="" className="h-32 w-auto opacity-90" />
              <p className="text-sm">Nothing here yet.</p>
              <p className="text-xs">Hit refresh, or connect Gmail in Settings.</p>
            </div>
          )}
          {filtered.map((e) => {
            const domain = e.from_addr?.includes("@") ? e.from_addr.split("@")[1]?.toLowerCase() ?? null : null;
            const folderList = foldersQ.data ?? [];
            const currentFolderId = e.folder_id;

            return (
            <ContextMenu key={e.id}>
              <ContextMenuTrigger asChild>
                <button
                  onClick={() => setSelectedId(e.id)}
                  className={`relative block w-full border-b border-border px-4 py-2 text-left transition-colors hover:bg-accent/50 ${selectedId === e.id ? "bg-accent" : ""}`}
                >
                  {!e.is_read && (
                    <span className="absolute left-1.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary" aria-hidden />
                  )}
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-sm text-foreground ${e.is_read ? "font-medium" : "font-semibold"}`}>{decodeEntities(e.from_name) || e.from_addr || "Unknown"}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {e.received_at ? formatDistanceToNow(new Date(e.received_at), { addSuffix: false }) : ""}
                    </span>
                  </div>
                  <div className={`truncate text-sm ${e.is_read ? "text-foreground/85" : "text-foreground"}`}>{decodeEntities(e.subject) || "(no subject)"}</div>
                  {e.ai_summary ? (
                    <div className="mt-1 flex items-start gap-1.5 text-xs text-primary/90">
                      <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                      <span className="line-clamp-1">{decodeEntities(e.ai_summary)}</span>
                    </div>
                  ) : (
                    <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">{decodeEntities(e.snippet)}</div>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-64">
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <FolderInput className="mr-2 h-4 w-4" />
                    Move to folder
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="max-h-72 overflow-y-auto">
                    {currentFolderId && (
                      <>
                        <ContextMenuItem
                          onSelect={async () => {
                            qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) => prev?.map((x) => (x.id === e.id ? { ...x, folder_id: null, is_archived: false, classified_by: "manual_inbox" } : x)));
                            try {
                              await moveInboxFn({ data: { email_id: e.id } });
                              toast.success("Moved to inbox");
                              qc.invalidateQueries({ queryKey: ["emails"] });
                            } catch (err: any) {
                              qc.invalidateQueries({ queryKey: ["emails"] });
                              toast.error(err.message);
                            }
                          }}
                        >
                          <Inbox className="mr-2 h-4 w-4" />
                          Inbox (no folder)
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                      </>
                    )}
                    {folderList.length === 0 && (
                      <ContextMenuItem disabled>No folders yet</ContextMenuItem>
                    )}
                    {folderList.filter((f) => f.id !== currentFolderId).map((f) => (
                      <ContextMenuItem
                        key={f.id}
                        onSelect={async () => {
                          qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) => prev?.map((x) => (x.id === e.id ? { ...x, folder_id: f.id, is_archived: true, classified_by: "manual_move" } : x)));
                          try {
                            await moveFolderFn({ data: { email_id: e.id, to_folder_id: f.id } });
                            toast.success(`Moved to ${f.name}`);
                            qc.invalidateQueries({ queryKey: ["emails"] });
                          } catch (err: any) {
                            qc.invalidateQueries({ queryKey: ["emails"] });
                            toast.error(err.message);
                          }
                        }}
                      >
                        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: f.color }} />
                        <span className="truncate">{f.name}</span>
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>

                <ContextMenuSeparator />
                <ContextMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Always send to inbox
                </ContextMenuLabel>
                {e.from_addr ? (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <AtSign className="mr-2 h-4 w-4" />
                      <span className="truncate">Just {e.from_addr}</span>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem
                        onSelect={async () => {
                          try {
                            const r = await addOverrideFn({ data: { value: e.from_addr!, match_type: "email" } });
                            qc.invalidateQueries({ queryKey: ["inbox-overrides"] });
                            toast.success(r.already ? `${e.from_addr} already on the list` : `Future mail from ${e.from_addr} will go to inbox`);
                          } catch (err: any) { toast.error(err.message); }
                        }}
                      >
                        Future emails only
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={async () => {
                          const sender = (e.from_addr || "").toLowerCase();
                          // Optimistically remove all rows from this sender across cached email pages.
                          qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                            prev?.filter((x) => (x.from_addr || "").toLowerCase() !== sender),
                          );
                          try {
                            const r = await stripLabelFn({ data: { value: e.from_addr!, match_type: "email" } });
                            qc.invalidateQueries({ queryKey: ["emails"] });
                            qc.invalidateQueries({ queryKey: ["emails-summary"] });
                            toast.success(`Removed folder label from ${r.stripped_count} past email${r.stripped_count === 1 ? "" : "s"}`);
                          } catch (err: any) {
                            qc.invalidateQueries({ queryKey: ["emails"] });
                            toast.error(err.message);
                          }
                        }}
                      >
                        Remove folder label from past emails
                      </ContextMenuItem>

                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ) : (
                  <ContextMenuItem disabled>No sender address</ContextMenuItem>
                )}
                {domain && (
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Globe className="mr-2 h-4 w-4" />
                      <span className="truncate">Anyone @{domain}</span>
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuItem
                        onSelect={async () => {
                          try {
                            const r = await addOverrideFn({ data: { value: domain, match_type: "domain" } });
                            qc.invalidateQueries({ queryKey: ["inbox-overrides"] });
                            toast.success(r.already ? `@${domain} already on the list` : `Future mail from @${domain} will go to inbox`);
                          } catch (err: any) { toast.error(err.message); }
                        }}
                      >
                        Future emails only
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={async () => {
                          const d = domain.toLowerCase();
                          qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                            prev?.filter((x) => ((x.from_addr || "").toLowerCase().split("@")[1] || "") !== d),
                          );
                          try {
                            const r = await stripLabelFn({ data: { value: domain, match_type: "domain" } });
                            qc.invalidateQueries({ queryKey: ["emails"] });
                            qc.invalidateQueries({ queryKey: ["emails-summary"] });
                            toast.success(`Removed folder label from ${r.stripped_count} past email${r.stripped_count === 1 ? "" : "s"}`);
                          } catch (err: any) {
                            qc.invalidateQueries({ queryKey: ["emails"] });
                            toast.error(err.message);
                          }
                        }}
                      >
                        Remove folder label from past emails
                      </ContextMenuItem>

                    </ContextMenuSubContent>
                  </ContextMenuSub>
                )}

                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={async () => {
                    qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) => prev?.map((x) => (x.id === e.id ? { ...x, is_archived: true } : x)));
                    try { await archFnList({ data: { id: e.id } }); toast.success("Archived"); }
                    catch (err: any) { qc.invalidateQueries({ queryKey: ["emails"] }); toast.error(err.message); }
                  }}
                >
                  <Archive className="mr-2 h-4 w-4" />
                  Archive
                </ContextMenuItem>
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={async () => {
                    qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) => prev?.filter((x) => x.id !== e.id));
                    try { await trashFnList({ data: { id: e.id } }); toast.success("Trashed"); }
                    catch (err: any) { qc.invalidateQueries({ queryKey: ["emails"] }); toast.error(err.message); }
                  }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Trash
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            );
          })}
        </div>
        {!isSearching && (
          <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={goPrev} disabled={page === 1}>
              <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Prev
            </Button>
            <span>
              Page {page}
              {pullOlderMut.isPending ? " · pulling from Gmail…" : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={goNext}
              disabled={!canGoNext || pullOlderMut.isPending}
              title={!canGoNext ? "No more emails in this view" : !hasMoreLocal ? "Pull next 50 from Gmail" : ""}
            >
              Next <ChevronLeft className="ml-1 h-3.5 w-3.5 rotate-180" />
            </Button>
          </div>
        )}
      </div>

      {/* Reading pane */}
      <div className={`h-full overflow-hidden ${selected ? "block" : "hidden md:block"}`}>
        {selected ? <Reader key={selected.id} email={selected} folders={foldersQ.data ?? []} onBack={() => setSelectedId(null)} /> : (
          <TrackingStandby />
        )}
      </div>
    </div>
  );
}

function labelForFolder(sel: string | "all" | "all_mail" | "no_rules", folders: Folder[]) {
  if (sel === "all") return "All inbox";
  if (sel === "all_mail") return "All mail";
  if (sel === "no_rules") return "No rules";
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
  const resyncFn = useServerFn(resyncMessage);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [alwaysInbox, setAlwaysInbox] = useState<null | { fromAddr: string | null; domain: string | null }>(null);
  const [reply, setReply] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [moving, setMoving] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(true);
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
    qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
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
    qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
      prev?.map((e) => (e.id === email.id ? { ...e, folder_id: target.id, is_archived: true } : e)),
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
    <div className="relative flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && (
            <button onClick={onBack} className="grid h-8 w-8 place-items-center rounded-md hover:bg-accent md:hidden" aria-label="Back">
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {folder && <Badge variant="outline" className="hidden gap-1.5 md:inline-flex"><span className="h-2 w-2 rounded-full" style={{ background: folder.color }} />{folder.name}</Badge>}
          {email.ai_confidence != null && email.ai_summary && (
            <Badge variant="outline" className="hidden gap-1 text-xs md:inline-flex"><Sparkles className="h-3 w-3" />AI · {Math.round(email.ai_confidence * 100)}%</Badge>
          )}
        </div>
        <div className="flex flex-nowrap gap-0.5 overflow-x-auto md:gap-1">
          <Button size="sm" variant="default" onClick={() => setReplyOpen(true)} className="h-8 px-2.5">
            <Reply className="mr-1.5 h-3.5 w-3.5" />Reply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            disabled={reanalyzing}
            title="Re-analyze with current folders & rules"
            onClick={async () => {
              setReanalyzing(true);
              try {
                const r = await reanalyzeFn({ data: { email_id: email.id } });
                qc.invalidateQueries({ queryKey: ["emails"] });
                qc.invalidateQueries({ queryKey: ["emails-summary"] });
                if (r.classified_by === "ai_error") {
                  toast.error(r.classification_reason || "AI classifier failed");
                } else if (r.classified_by === "kept") {
                  const name = folders.find((f) => f.id === r.folder_id)?.name;
                  toast.message(name ? `No better folder — kept in ${name}.` : "No better folder — kept current.");
                } else if (!r.changed) {
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
              <Button size="sm" variant="ghost" className="h-8 px-1.5" disabled={moving} title="Move to folder">
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
                      qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
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
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => {
            const next = !email.is_read;
            qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) => prev?.map((e) => (e.id === email.id ? { ...e, is_read: next } : e)));
            markFn({ data: { id: email.id, read: next } }).catch(() => qc.invalidateQueries({ queryKey: ["emails"] }));
          }}>
            {email.is_read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={async () => {
            qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) => prev?.map((e) => (e.id === email.id ? { ...e, is_archived: true } : e)));
            try { await archFn({ data: { id: email.id } }); toast.success("Archived"); }
            catch (e: any) { qc.invalidateQueries({ queryKey: ["emails"] }); toast.error(e.message); }
          }}>
            <Archive className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={async () => {
            qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) => prev?.filter((e) => e.id !== email.id));
            try { await trashFn({ data: { id: email.id } }); toast.success("Trashed"); }
            catch (e: any) { qc.invalidateQueries({ queryKey: ["emails"] }); toast.error(e.message); }
          }}>
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            disabled={resyncing}
            title="Resync labels from Gmail"
            onClick={async () => {
              setResyncing(true);
              try {
                const r = await resyncFn({ data: { id: email.id } });
                qc.invalidateQueries({ queryKey: ["emails"] });
                qc.invalidateQueries({ queryKey: ["emails-summary"] });
                if ((r as any).deleted) toast.message("Removed — no longer in Gmail");
                else if ((r as any).in_inbox) toast.success("Resynced — back in Inbox");
                else toast.success("Resynced from Gmail");
              } catch (e: any) {
                toast.error(e.message);
              } finally {
                setResyncing(false);
              }
            }}
          >
            <RefreshCw className={`h-4 w-4 ${resyncing ? "animate-spin" : ""}`} />
          </Button>

        </div>

      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3 md:px-6">
        <h1 className="font-display text-xl leading-tight md:text-2xl">{email.subject || "(no subject)"}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          <strong className="text-foreground">{email.from_name || email.from_addr}</strong>
          {email.from_name && email.from_addr ? ` <${email.from_addr}>` : ""}
          {email.received_at && ` · ${new Date(email.received_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}
        </p>
        {email.ai_summary && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-sm">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span><span className="font-medium text-primary">Summary · </span>{email.ai_summary}</span>
          </div>
        )}

        <Collapsible open={whyOpen} onOpenChange={setWhyOpen} className="mt-1.5">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between rounded-md border border-border bg-card/30 px-3 py-1 text-left text-sm hover:bg-accent/40">
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
            {email.processed_at && email.received_at && (
              <div className="text-xs text-muted-foreground">
                Synced{" "}
                {(() => {
                  const delta = Math.max(0, Math.round((new Date(email.processed_at).getTime() - new Date(email.received_at).getTime()) / 1000));
                  if (delta < 90) return `${delta}s`;
                  if (delta < 3600) return `${Math.round(delta / 60)} min`;
                  return `${Math.round(delta / 3600)}h`;
                })()}{" "}
                after Gmail received it
                {email.processed_at && (
                  <> · {new Date(email.processed_at).toLocaleString()}</>
                )}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        <div className="mt-4">
          {email.body_html ? (
            <EmailBodyFrame html={email.body_html} />
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">{email.body_text}</pre>
          )}
        </div>
      </div>

      <div
        className={`absolute inset-x-0 bottom-0 z-20 border-t border-border bg-card shadow-2xl transition-transform duration-300 ease-out ${
          replyOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="truncate text-xs uppercase tracking-widest text-muted-foreground">
            Reply to {email.from_name || email.from_addr}
          </span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={generating}
              onClick={async () => {
                setGenerating(true);
                try { const r = await genFn({ data: { id: email.id } }); setReply(r.draft); } catch (e: any) { toast.error(e.message); }
                setGenerating(false);
              }}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />{generating ? "Drafting…" : "Suggest reply"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setReplyOpen(false)} aria-label="Close reply">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="p-4">
          <Textarea rows={6} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Write a reply…" autoFocus={replyOpen} />
          <div className="mt-2 flex justify-end">
            <Button size="sm" disabled={!reply.trim() || sending}
              onClick={async () => {
                setSending(true);
                try {
                  await sendFn({ data: { id: email.id, body: reply } });
                  toast.success("Sent");
                  setReply("");
                  setReplyOpen(false);
                } catch (e: any) { toast.error(e.message); }
                setSending(false);
              }}>
              <Send className="mr-1.5 h-3.5 w-3.5" />Send
            </Button>
          </div>
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
      {alwaysInbox && (
        <AlwaysInboxDialog
          open={!!alwaysInbox}
          onOpenChange={(v) => { if (!v) setAlwaysInbox(null); }}
          emailId={email.id}
          fromAddr={alwaysInbox.fromAddr}
          domain={alwaysInbox.domain}
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
