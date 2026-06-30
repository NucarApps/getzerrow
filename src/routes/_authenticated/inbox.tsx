import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useState, useMemo, useId, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  triggerSync,
  markEmailRead,
  archiveEmail,
  trashEmail,
  generateReply,
  sendReply,
  moveEmailToFolder,
  reanalyzeEmail,
  moveEmailToInbox,
  loadOlderFromGmail,
  searchGmailAndIngest,
  resyncMessage,
  reclassifyEmails,
  suggestFolderFromSelection,
  createFolderAndAssign,
  reconcileInboxFromGmail,
  syncMyReadState,
  backgroundSync,
} from "@/lib/gmail.functions";
import { BACKGROUND_SYNC_INTERVAL_MS } from "@/lib/sync/config";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
  ContextMenuLabel,
} from "@/components/ui/context-menu";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sparkles,
  Archive,
  Trash2,
  RefreshCw,
  Mail,
  MailOpen,
  Send,
  Inbox,
  ChevronLeft,
  FolderInput,
  ChevronDown,
  Bot,
  Filter as FilterIcon,
  Tag,
  Hand,
  HelpCircle,
  Search,
  X,
  RotateCw,
  Reply,
  UserPlus,
} from "lucide-react";
import { addContactFromEmail } from "@/lib/contacts.functions";
import {
  getEmailBody,
  getEmailListFields,
  getInboxList,
  searchInbox,
} from "@/lib/email-body.functions";
import { metaKeyFor, loadInboxMeta, saveInboxMeta } from "@/lib/inbox-meta-cache";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useFolderSelection } from "@/lib/folder-selection";
import { useAccountSelection } from "@/lib/account-selection";
import { MoveSimilarDialog } from "@/components/emails/MoveSimilarDialog";
import { AlwaysInboxDialog } from "@/components/emails/AlwaysInboxDialog";
import { FilterLikeThisDrawer } from "@/components/emails/FilterLikeThisDrawer";
import cobwebInbox from "@/assets/cobweb-inbox.svg";
import { collectMatchingLeaves } from "@/lib/sync/filter-engine";
import type { RuleNode } from "@/lib/sync/types";
import { TrackingStandby } from "@/components/inbox/TrackingStandby";
import { AssistantPanel } from "@/components/inbox/AssistantPanel";
import { PullToRefresh } from "@/components/inbox/PullToRefresh";
import { useIsMobile } from "@/hooks/use-mobile";
import DOMPurify from "dompurify";

export const Route = createFileRoute("/_authenticated/inbox")({
  component: InboxPage,
  head: () => ({
    links: [{ rel: "stylesheet", href: "/zerrow-landing.css" }],
  }),
});

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decodeEntities(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Email = {
  id: string;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  body_text?: string | null;
  body_html?: string | null;
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
  matched_folder_ids: string[] | null;
  to_addrs: string | null;
  has_attachment: boolean;
  processed_at: string | null;
  raw_labels?: string[] | null;
  snoozed_until?: string | null;
  gmail_message_id?: string | null;
  // Set on rows reconstructed from the metadata-only localStorage cache: the
  // content fields (sender, subject, snippet, ai summary) are null and shimmer
  // in the UI until the live DB read replaces the row.
  __placeholder?: boolean;
};

type Folder = {
  id: string;
  name: string;
  color: string;
  gmail_label_id: string | null;
  auto_archive: boolean;
  hide_from_inbox: boolean;
};

const IN_PROGRESS_CLASSIFICATIONS = new Set(["pending", "pending_ai"]);

function isInProgressEmail(email: Pick<Email, "classified_by">): boolean {
  return (
    typeof email.classified_by === "string" && IN_PROGRESS_CLASSIFICATIONS.has(email.classified_by)
  );
}

function emailBelongsInScope(email: Email, selectedFolder: string, folders: Folder[]): boolean {
  if (selectedFolder === "all_mail") return true;
  if (isInProgressEmail(email)) return false;
  const snoozedMs = email.snoozed_until ? new Date(email.snoozed_until).getTime() : 0;
  if (snoozedMs && snoozedMs > Date.now()) return false;
  const labels = email.raw_labels ?? [];
  const folder = email.folder_id ? folders.find((f) => f.id === email.folder_id) : null;
  if (selectedFolder === "all") {
    return (
      email.is_archived !== true &&
      labels.includes("INBOX") &&
      !(folder?.auto_archive || folder?.hide_from_inbox)
    );
  }
  if (selectedFolder === "no_rules") {
    return email.folder_id === null && !labels.some((label) => label.startsWith("Label_"));
  }
  return email.folder_id === selectedFolder;
}

const PAGE_SIZE = 50;

const withInbox = (labels: string[] | null | undefined): string[] =>
  Array.from(new Set([...(labels ?? []), "INBOX"]));
const withoutInbox = (labels: string[] | null | undefined): string[] =>
  (labels ?? []).filter((l) => l !== "INBOX");

const MIN_PX = 400;

function hasVisibleHtml(html: string | null | undefined): boolean {
  return (
    (html ?? "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;|\s/g, "").length > 0
  );
}

function EmailBodyFrame({ html }: { html: string }) {
  const frameId = useId();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const srcDoc = useMemo(() => {
    // Sanitize email HTML to strip <script>, event handlers, and other
    // dangerous constructs BEFORE injecting into the iframe. Even though the
    // iframe is sandboxed without allow-same-origin, attacker scripts could
    // otherwise auto-execute (outbound tracking beacons, popup phishing).
    // Stripping them at the source removes that capability entirely.
    const cleanHtml = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target"],
      FORBID_TAGS: ["script", "object", "embed", "form", "input", "meta", "link"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "onsubmit"],
    });
    const resizeScript = `
<script>
(function(){
  var id = ${JSON.stringify(frameId)};
  function post(){
    try {
      var h = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      parent.postMessage({ __zerrowFrame: id, height: h }, "*");
    } catch(e){}
  }
  post();
  document.addEventListener("DOMContentLoaded", function(){
    post();
    if (typeof ResizeObserver !== "undefined" && document.body) {
      try { new ResizeObserver(post).observe(document.body); } catch(e){}
    }
    var imgs = document.getElementsByTagName("img");
    for (var i=0; i<imgs.length; i++) {
      imgs[i].addEventListener("load", post);
      imgs[i].addEventListener("error", post);
    }
  });
  window.addEventListener("load", function(){
    post();
    requestAnimationFrame(post);
    setTimeout(post, 100);
    setTimeout(post, 400);
    setTimeout(post, 1200);
  });
  window.addEventListener("resize", post);
  window.addEventListener("message", function(e){
    if (e && e.data && e.data.__zerrowPing === id) post();
  });
})();
</script>`;
    return `<!doctype html><html><head><base target="_blank"><meta charset="utf-8"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light only;}html,body{margin:0;padding:16px;background:#fff !important;color:#111 !important;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;word-wrap:break-word;overflow-wrap:break-word;}body *{color:inherit;}img{max-width:100%;height:auto;}a{color:#2563eb !important;}table{max-width:100%;}</style></head><body>${cleanHtml}${resizeScript}</body></html>`;
  }, [html, frameId]);

  useLayoutEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only accept height reports from our own sandboxed iframe. Its origin is
      // opaque ("null") for a srcdoc sandbox, so we pin to the contentWindow and
      // the per-render frameId nonce rather than checking e.origin.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { __zerrowFrame?: string; height?: number } | null;
      if (!d || d.__zerrowFrame !== frameId || typeof d.height !== "number") return;
      const f = iframeRef.current;
      if (!f) return;
      const clamped = Math.min(Math.max(d.height + 4, MIN_PX), 8000);
      f.style.height = clamped + "px";
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameId]);

  function pingForHeight() {
    const f = iframeRef.current;
    // The email iframe is sandboxed without allow-same-origin, so its origin is
    // opaque ("null") and "*" is the only targetOrigin that can reach it. The
    // payload is a non-sensitive per-render nonce (no user data) sent only to our
    // own iframe's contentWindow, so wildcard disclosure is moot.
    try {
      // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
      f?.contentWindow?.postMessage({ __zerrowPing: frameId }, "*");
    } catch {
      /* best-effort: iframe may not be ready yet */
    }
  }

  return (
    <iframe
      ref={iframeRef}
      title="Email body"
      srcDoc={srcDoc}
      onLoad={pingForHeight}
      sandbox="allow-popups allow-scripts"
      className="w-full rounded-lg bg-white"
      style={{ border: 0, colorScheme: "light", height: MIN_PX, minHeight: MIN_PX }}
    />
  );
}

function EmailBodyInline({ html }: { html: string }) {
  const clean = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["target"],
        FORBID_TAGS: [
          "script",
          "style",
          "iframe",
          "object",
          "embed",
          "form",
          "input",
          "meta",
          "link",
        ],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
      }),
    [html],
  );
  return (
    <div
      className="email-body-inline rounded-lg bg-white p-4 text-[14px] leading-relaxed text-[#111]"
      style={{ colorScheme: "light", wordWrap: "break-word", overflowWrap: "break-word" }}
      // `clean` is DOMPurify-sanitized HTML (see useMemo above).
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

function SwipeRow({ onArchive, children }: { onArchive: () => void; children: React.ReactNode }) {
  const [dx, setDx] = useState(0);
  const startRef = useRef<{ x: number; y: number; active: boolean; locked: boolean } | null>(null);

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY, active: true, locked: false };
  }
  function onTouchMove(e: React.TouchEvent) {
    const s = startRef.current;
    if (!s || !s.active) return;
    const t = e.touches[0];
    const dxRaw = t.clientX - s.x;
    const dyRaw = t.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dxRaw) < 8 && Math.abs(dyRaw) < 8) return;
      if (Math.abs(dyRaw) > Math.abs(dxRaw)) {
        s.active = false;
        return;
      }
      s.locked = true;
    }
    setDx(Math.min(0, dxRaw));
  }
  function onTouchEnd(e: React.TouchEvent) {
    const s = startRef.current;
    startRef.current = null;
    if (!s || !s.locked) {
      setDx(0);
      return;
    }
    const width = (e.currentTarget as HTMLElement).offsetWidth || 1;
    if (-dx > width * 0.25) {
      setDx(0);
      onArchive();
    } else {
      setDx(0);
    }
  }

  return (
    <div className="relative overflow-hidden border-b border-border">
      <div className="pointer-events-none absolute inset-0 flex items-center justify-end bg-destructive pr-6 text-destructive-foreground">
        <Archive className="h-5 w-5" />
      </div>
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          transform: `translateX(${dx}px)`,
          transition: dx === 0 ? "transform 120ms ease-out" : "none",
        }}
        className="relative bg-background"
      >
        {children}
      </div>
    </div>
  );
}

function parseSearchQuery(input: string): { from: string | null; to: string | null; rest: string } {
  let from: string | null = null;
  let to: string | null = null;
  // Match from:value or to:value where value is either "quoted string" or non-whitespace.
  const re = /\b(from|to):\s*(?:"([^"]+)"|(\S+))/gi;
  const rest = input
    .replace(re, (_m, key: string, quoted?: string, bare?: string) => {
      const value = (quoted ?? bare ?? "").trim();
      if (!value) return "";
      if (key.toLowerCase() === "from") from = value;
      else to = value;
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { from, to, rest };
}

function InboxPage() {
  const qc = useQueryClient();
  const sync = useServerFn(triggerSync);
  const backgroundSyncFn = useServerFn(backgroundSync);
  // Shared guard so the open catch-up, the recurring background tick, and the
  // manual Refresh button never run a sync on top of each other.
  const syncInFlightRef = useRef(false);
  const fetchEmailBody = useServerFn(getEmailBody);
  const moveFolderFn = useServerFn(moveEmailToFolder);
  const moveInboxFn = useServerFn(moveEmailToInbox);

  const archFnList = useServerFn(archiveEmail);
  const trashFnList = useServerFn(trashEmail);
  const { selected: selectedFolder } = useFolderSelection();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Debounced copy of `query` that drives all *data* fetching. The input stays
  // bound to `query` for instant typing feedback, but the heavy search only
  // fires ~250ms after the user stops typing, so each keystroke no longer kicks
  // off a request.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(h);
  }, [query]);
  const searchInboxFn = useServerFn(searchInbox);
  const [filterPrompt, setFilterPrompt] = useState<null | {
    fromAddr: string | null;
    subject: string | null;
    currentFolderId: string | null;
  }>(null);

  const { activeAccountId } = useAccountSelection();
  const accountId = activeAccountId;

  const foldersQ = useQuery({
    queryKey: ["folders", accountId],
    enabled: !!accountId,
    queryFn: async () => {
      const { data } = await supabase
        .from("folders")
        .select("id,name,color,gmail_label_id,auto_archive,hide_from_inbox")
        .eq("gmail_account_id", accountId!)
        .order("priority", { ascending: false });
      return (data ?? []) as Folder[];
    },
  });

  // Search data fetching keys off the debounced term so it's stable across
  // keystrokes; `searchTerm` is the single source of truth for "what are we
  // searching for right now".
  const searchTerm = debouncedQuery.trim();
  const isSearching = searchTerm.length > 0;

  // Pagination state — reset to page 1 whenever the folder or search changes.
  // cursors[i] is the `received_at <` cursor used to fetch page i+1 (cursors[0] = null).
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [assistantOpen, setAssistantOpen] = useState(false);
  // True while the silent background catch-up is in flight — drives the subtle
  // "Syncing…" header hint (never blocks the list).
  const [bgSyncing, setBgSyncing] = useState(false);
  const isNoRules = selectedFolder === "no_rules";
  useEffect(() => {
    setPage(1);
    setCursors([null]);
    setSelectedId(null);
    setSelectedIds(new Set());
    setQuery("");
    setDebouncedQuery("");
    setLastGmailResult(null);
    setGmailHitIds({ query: "", ids: new Set() });
  }, [selectedFolder]);
  // A new/changed search restarts at page 1 so the offset window is correct.
  useEffect(() => {
    setPage(1);
    setCursors([null]);
  }, [searchTerm]);
  const cursor = cursors[page - 1] ?? null;

  const reclassifyFn = useServerFn(reclassifyEmails);
  const suggestFolderFn = useServerFn(suggestFolderFromSelection);
  const createFolderAndAssignFn = useServerFn(createFolderAndAssign);
  const [suggestion, setSuggestion] = useState<null | {
    name: string;
    color: string;
    ai_rule: string;
    filter_field: string | null;
    filter_op: string | null;
    filter_value: string;
    why: string;
    email_ids: string[];
  }>(null);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [reclassifyBusy, setReclassifyBusy] = useState(false);

  const loadOlderFn = useServerFn(loadOlderFromGmail);

  // Columns selected for any list view. Excludes body_text + body_html
  // (often multi-MB) — those are fetched on-demand via selectedFullQ when
  // the user actually opens an email. Keeps both the initial fetch AND
  // every realtime UPDATE payload small. raw_labels is included because
  // the "no_rules" filter reads it. snoozed_until is included so local
  // search results can apply the same visibility filter as normal lists.
  // forward_* columns are operator-facing, not rendered in the inbox.
  const LIST_COLUMNS =
    "id,from_addr,received_at,is_read,is_archived,folder_id,ai_confidence,thread_id,classified_by,matched_filter_ids,matched_folder_ids,has_attachment,processed_at,raw_labels,snoozed_until,gmail_message_id";

  // Parse the search query once so both the data fetcher and the local filter
  // agree on what's an operator query vs free-text.
  const parsedQuery = useMemo(() => parseSearchQuery(searchTerm), [searchTerm]);
  

  // No entry pre-sync gate. The inbox renders immediately from the local DB
  // (the source of truth, kept current by the webhook + poll crons), and the
  // Gmail catch-up runs silently in the background on mount (see the
  // background-sync effect below). Anything it discovers flows in via realtime
  // + a change-gated invalidate, so first paint never waits on a Gmail
  // round-trip and the list no longer shows a blocking "Catching up…" gate.
  const fetchInboxList = useServerFn(getInboxList);

  // Key for the metadata-only localStorage cache, mirroring the non-search
  // query-key segments below. Used as a 0ms placeholder on a cold reload so the
  // inbox *structure* paints instantly while content hydrates from the DB read.
  const metaKey =
    accountId && !isSearching ? metaKeyFor(accountId, selectedFolder, page, cursor) : null;
  const emailsQ = useQuery<Email[]>({
    queryKey: [
      "emails",
      accountId,
      selectedFolder,
      isSearching
        ? `search:${searchTerm.toLowerCase()}:p${page}`
        : `page:${page}:${cursor ?? "start"}`,
    ],
    enabled: !!accountId && (!isSearching || foldersQ.isSuccess),
    queryFn: async () => {
      const isNoRules = selectedFolder === "no_rules";
      const isAllMail = selectedFolder === "all_mail";
      const folderRows = foldersQ.data ?? [];
      if (isSearching) {
        // Single server-side path for both free-text and `from:` / `to:`
        // operator search. The server ranks over the GIN-indexed search index:
        // free-text against subject/snippet/body + sender/recipient, and
        // operators against the dedicated participant index (sender = weight A,
        // recipient = weight B) across the WHOLE mailbox — no longer capped by
        // a recent-rows window, and matched by email address AND display name.
        // Only matched rows are decrypted server-side, so the browser never
        // downloads or fuzzy-scores the corpus (the old freeze).
        const res = await searchInboxFn({
          data: {
            query: searchTerm,
            from: parsedQuery.from,
            to: parsedQuery.to,
            rest: parsedQuery.rest,
            account_id: accountId!,
            // Strict, small result window: fetch exactly one page (+1 sentinel
            // row to detect "has more"). The SQL search RPC applies this
            // LIMIT/OFFSET on the index BEFORE joining `emails`, so the join
            // never reads more than PAGE_SIZE + 1 rows per search page.
            limit: PAGE_SIZE + 1,
            offset: (page - 1) * PAGE_SIZE,
          },
        });
        const hits = res.rows ?? [];
        if (hits.length === 0) return [];
        const ids = hits.map((h) => h.id);
        const { data } = await supabase.from("emails").select(LIST_COLUMNS).in("id", ids);
        const metaById = new Map<string, Email>();
        for (const m of (data ?? []) as unknown as Email[]) metaById.set(m.id, m);
        const rows = hits
          .map((h) => {
            const meta = metaById.get(h.id);
            if (!meta) return null;
            // Attach the already-decrypted content fields so the row renders
            // without a second decrypt round-trip (listFieldsQ skips it).
            return {
              ...meta,
              subject: h.subject,
              snippet: h.snippet,
              from_name: h.from_name,
            } as unknown as Email;
          })
          .filter((r): r is Email => r !== null);
        return rows.filter((email) => emailBelongsInScope(email, selectedFolder, folderRows));
      }
      // Non-search: one decrypted, server-paginated round-trip. The RPC
      // applies the snoozed / INBOX / no-rules / folder filters and returns
      // sender + subject + AI fields already decrypted, so the list renders
      // in a single pass instead of a metadata fetch + separate decrypt call.
      const scope: "all" | "all_mail" | "no_rules" | "folder" = isAllMail
        ? "all_mail"
        : isNoRules
          ? "no_rules"
          : selectedFolder === "all"
            ? "all"
            : "folder";
      const r = await fetchInboxList({
        data: {
          account_id: accountId!,
          scope,
          folder_id: scope === "folder" ? selectedFolder : null,
          cursor,
          limit: PAGE_SIZE + 1,
        },
      });
      const rows = (r.rows ?? []) as unknown as Email[];
      // Persist non-content metadata for a 0ms structural paint on the next
      // cold reload of this exact view (no decrypted content is written —
      // saveInboxMeta projects to a fixed allowlist).
      if (metaKey) saveInboxMeta(metaKey, rows as unknown as Record<string, unknown>[]);
      return rows;
    },
    // Realtime keeps this list live (inserts/updates/deletes are patched into
    // the cache directly), so we don't poll on an interval — that just re-ran
    // the decrypt round-trip every 15s. Refresh on focus + manual pull only.
    refetchOnWindowFocus: true,
    // Keep the previous list painted across folder/page switches (no empty
    // flash); on a cold mount with nothing in memory, fall back to the
    // metadata-only localStorage cache so the structure paints at 0ms.
    placeholderData: (prev: Email[] | undefined) =>
      prev ?? (metaKey ? (loadInboxMeta(metaKey) as unknown as Email[] | undefined) : undefined),
  });

  // Background self-heal: ask Gmail which currently-inbox messages have
  // been archived externally, and reconcile our rows. Realtime UPDATE
  // events on `emails` then drop the archived rows out of this view
  // without the user touching anything.
  const reconcileInboxFn = useServerFn(reconcileInboxFromGmail);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await reconcileInboxFn({ data: { gmail_account_id: accountId } });
        const changed =
          r &&
          ((r as { reconciled?: number }).reconciled ||
            (r as { deleted?: number }).deleted ||
            (r as { restored?: number }).restored ||
            (r as { ingested?: number }).ingested);
        if (!cancelled && changed) {
          qc.invalidateQueries({ queryKey: ["emails"] });
          qc.invalidateQueries({ queryKey: ["folder-counts"] });
        }
      } catch {
        // best-effort; the cron reconcile path is the backstop.
      }
    };
    // Initial run after a short delay so the page loads first. The 15-minute
    // pg_cron reconcile is the real backstop; this in-tab loop is a light
    // self-heal, so we run it infrequently rather than every 45s per tab.
    const initial = setTimeout(tick, 3_000);
    const handle = setInterval(tick, 300_000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(handle);
    };
  }, [accountId, reconcileInboxFn, qc]);

  // Keep the unread dots matched with Gmail. A single is:unread diff per
  // account (whole mailbox, all folders) marks read/unread anything changed
  // directly in Gmail. The is_read updates flow back through realtime, so the
  // dots update in place. Runs on mount and whenever the tab regains focus;
  // the 15-minute reconcile cron is the backstop. Debounced so rapid focus
  // toggles don't fan out duplicate calls.
  const syncReadStateFn = useServerFn(syncMyReadState);
  useEffect(() => {
    let cancelled = false;
    let lastRun = 0;
    const run = async () => {
      const now = Date.now();
      if (now - lastRun < 15_000) return;
      lastRun = now;
      try {
        await syncReadStateFn();
      } catch {
        // best-effort; the reconcile cron is the backstop.
      }
      if (cancelled) return;
    };
    const initial = setTimeout(run, 1_500);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [syncReadStateFn]);

  // Keep an open inbox current without a manual refresh or page reload. A
  // lightweight background sync (history pull + bounded queue drain) runs once
  // immediately on mount, then on a steady interval and on tab refocus. Silent
  // — no gate, just the header "Syncing…" pulse — new mail flows in via
  // realtime + a change-gated invalidate. Paused while hidden; skipped while
  // any other sync is in flight.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "visible") return;
      if (syncInFlightRef.current) return;
      syncInFlightRef.current = true;
      setBgSyncing(true);
      try {
        const r = (await backgroundSyncFn({ data: { account_id: accountId } })) as {
          synced?: number;
          catchup?: { inserted?: number };
        };
        // Only refetch when the sync actually pulled new mail — otherwise the
        // list would needlessly re-run the decrypt round-trip on every tick.
        // (In-Gmail label/archive changes aren't in this count; they arrive via
        // realtime UPDATE/DELETE and the 5-min reconcile backstop.)
        const changed = (r?.synced ?? 0) > 0 || (r?.catchup?.inserted ?? 0) > 0;
        if (!cancelled && changed) {
          qc.invalidateQueries({ queryKey: ["emails"] });
          qc.invalidateQueries({ queryKey: ["folder-counts"] });
        }
      } catch {
        // best-effort; realtime + the 5-min reconcile are the backstop.
      } finally {
        syncInFlightRef.current = false;
        if (!cancelled) setBgSyncing(false);
      }
    };
    const handle = setInterval(tick, BACKGROUND_SYNC_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Immediate first catch-up on mount — silent and non-blocking; the list has
    // already painted from the local DB (and the metadata cache before that).
    void tick();
    return () => {
      cancelled = true;
      clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [accountId, backgroundSyncFn, qc]);

  // When searching, also ask Gmail for matching messages and ingest any we
  // don't have locally — then refetch so they appear in the results.
  const searchGmailFn = useServerFn(searchGmailAndIngest);
  const [gmailSearching, setGmailSearching] = useState(false);
  const [lastGmailResult, setLastGmailResult] = useState<{
    query: string;
    ingested: number;
    found: number;
    reason?: string;
  } | null>(null);
  const [gmailHitIds, setGmailHitIds] = useState<{ query: string; ids: Set<string> }>({
    query: "",
    ids: new Set(),
  });
  useEffect(() => {
    const qstr = searchTerm;
    if (qstr.length < 3) {
      setLastGmailResult(null);
      setGmailHitIds({ query: "", ids: new Set() });
      return;
    }
    const handle = setTimeout(async () => {
      setGmailSearching(true);
      try {
        const r: {
          ingested?: number;
          found?: number;
          reason?: string;
          hit_gmail_message_ids?: string[];
        } = await searchGmailFn({ data: { query: qstr } });
        setLastGmailResult({
          query: qstr,
          ingested: r?.ingested ?? 0,
          found: r?.found ?? 0,
          reason: r?.reason,
        });
        setGmailHitIds({ query: qstr.toLowerCase(), ids: new Set(r?.hit_gmail_message_ids ?? []) });
        if ((r?.ingested ?? 0) > 0) {
          await qc.refetchQueries({ queryKey: ["emails"] });
          toast.success(`Pulled ${r.ingested} email${r.ingested === 1 ? "" : "s"} from Gmail.`);
        }
      } catch (e) {
        console.error("gmail search failed", e);
      } finally {
        setGmailSearching(false);
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [searchTerm, searchGmailFn, qc]);

  // Supplemental fetch: pull rows for Gmail-hit ids in case they fall outside
  // the 5000-newest local corpus (older mail, archived threads, etc.).
  const gmailHitIdList = useMemo(
    () =>
      isSearching && gmailHitIds.query === searchTerm.toLowerCase()
        ? Array.from(gmailHitIds.ids)
        : [],
    [isSearching, gmailHitIds, searchTerm],
  );
  const gmailHitRowsQ = useQuery<Email[]>({
    queryKey: [
      "emails-gmail-hits",
      accountId,
      selectedFolder,
      searchTerm.toLowerCase(),
      gmailHitIdList.length,
    ],
    enabled: !!accountId && gmailHitIdList.length > 0 && foldersQ.isSuccess,
    queryFn: async () => {
      const ids = gmailHitIdList.slice(0, 500);
      const { data } = await supabase
        .from("emails")
        .select(LIST_COLUMNS)
        .eq("gmail_account_id", accountId!)
        .in("gmail_message_id", ids);
      const rows = (data ?? []) as unknown as Email[];
      return rows.filter((email) =>
        emailBelongsInScope(email, selectedFolder, foldersQ.data ?? []),
      );
    },
  });

  const rawEmails = useMemo(() => emailsQ.data ?? [], [emailsQ.data]);
  const hasMoreLocal = !isSearching && rawEmails.length > PAGE_SIZE;
  // The search query fetches PAGE_SIZE + 1 rows; a full extra row means there
  // is another page to offset into.
  const hasMoreSearch = isSearching && rawEmails.length > PAGE_SIZE;
  const baseRows = useMemo(() => {
    // Always trim to the page window so we never render the +1 sentinel row.
    const windowRows = rawEmails.slice(0, PAGE_SIZE);
    if (!isSearching) return windowRows;
    const extra = gmailHitRowsQ.data ?? [];
    if (extra.length === 0) return windowRows;
    const seen = new Set(windowRows.map((r) => r.id));
    const merged = [...windowRows];
    for (const r of extra) if (!seen.has(r.id)) merged.push(r);
    return merged;
  }, [isSearching, rawEmails, gmailHitRowsQ.data]);

  // Decrypt only the rows that still lack plaintext fields. The non-search
  // list now arrives already-decrypted from getInboxList, so those rows are
  // skipped here (no second round-trip). This still covers (a) search results,
  // which come from a raw metadata query, and (b) rows spliced in by realtime
  // INSERTs, which carry only the encrypted columns. A row needs decryption
  // when its `subject` key is absent (raw rows expose `subject_enc` instead).
  const visibleIds = useMemo(
    () =>
      baseRows
        .filter((r) => (r as { subject?: string | null }).subject === undefined)
        .map((r) => r.id),
    [baseRows],
  );
  const visibleIdsKey = useMemo(() => visibleIds.join(","), [visibleIds]);
  const fetchListFields = useServerFn(getEmailListFields);
  const listFieldsQ = useQuery({
    queryKey: ["emails-list-fields", visibleIdsKey],
    enabled: visibleIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetchListFields({ data: { ids: visibleIds } });
      const map = new Map<
        string,
        {
          ai_summary: string | null;
          classification_reason: string | null;
          subject: string | null;
          snippet: string | null;
          from_name: string | null;
          to_addrs: string | null;
          cc: string | null;
        }
      >();
      for (const f of r.fields ?? []) {
        map.set(f.id, {
          ai_summary: f.ai_summary ?? null,
          classification_reason: f.classification_reason ?? null,
          subject: f.subject ?? null,
          snippet: f.snippet ?? null,
          from_name: f.from_name ?? null,
          to_addrs: f.to_addrs ?? null,
          cc: f.cc ?? null,
        });
      }
      return map;
    },
  });
  const pageRows = useMemo(() => {
    const map = listFieldsQ.data;
    if (!map || map.size === 0) return baseRows;
    return baseRows.map((r) => {
      const extra = map.get(r.id);
      return extra
        ? {
            ...r,
            ai_summary: extra.ai_summary,
            classification_reason: extra.classification_reason,
            subject: extra.subject,
            snippet: extra.snippet,
            from_name: extra.from_name,
            to_addrs: extra.to_addrs,
            cc: extra.cc,
          }
        : r;
    });
  }, [baseRows, listFieldsQ.data]);

  const filtered = useMemo(() => {
    // Both free-text and `from:` / `to:` operator searches are now matched and
    // relevance-ranked entirely server-side (operators via the participant
    // index across the whole mailbox), so we keep the server order as-is — no
    // main-thread re-scoring, which was the source of the freeze.
    return pageRows;
  }, [pageRows]);


  const currentFolderObj = (foldersQ.data ?? []).find((f) => f.id === selectedFolder) ?? null;
  const canPullFromGmail = !!currentFolderObj?.gmail_label_id;

  const pullOlderMut = useMutation({
    mutationFn: async () => {
      if (!currentFolderObj?.gmail_label_id)
        throw new Error("This view isn't linked to a Gmail label.");
      const lastReceived = pageRows[pageRows.length - 1]?.received_at ?? null;
      return loadOlderFn({
        data: { folder_id: currentFolderObj.id, before_received_at: lastReceived },
      });
    },
    onSuccess: async (r) => {
      await qc.refetchQueries({ queryKey: ["emails", selectedFolder] });
      const pulled = (r?.ingested ?? 0) + (r?.claimed ?? 0);
      if (pulled > 0)
        toast.success(`Pulled ${pulled} older email${pulled === 1 ? "" : "s"} from Gmail.`);
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
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed to pull from Gmail"),
  });

  function goNext() {
    if (isSearching) {
      // Offset-based paging: the query key includes `page`, so bumping it
      // refetches the next PAGE_SIZE window from the search RPC.
      if (hasMoreSearch) setPage((p) => p + 1);
      return;
    }
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
  const canGoNext = isSearching
    ? hasMoreSearch
    : hasMoreLocal || canPullFromGmail;

  const selectedListItem = filtered.find((e) => e.id === selectedId) ?? null;

  // List rows omit body_text/body_html to keep payloads (initial query +
  // every realtime update) small. The detail pane needs the full body, so
  // we fetch on-demand whenever something is selected and merge with the
  // cached list row to render. 5min staleTime keeps clicks through a
  // recently-read thread free of refetches.
  const selectedFullQ = useQuery<Email | null>({
    queryKey: ["email-full", selectedId],
    enabled: !!selectedId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!selectedId) return null;
      // Body / AI summary / classification reason are encrypted at rest;
      // fetch via server fn that calls the SECURITY DEFINER decrypt RPC
      // with the server-held EMAIL_ENC_KEY. The list row already carries
      // subject/snippet/from_name (still plaintext) — we merge below.
      const res = await fetchEmailBody({ data: { email_id: selectedId } });
      if (!res.body) return null;
      return {
        id: res.body.id,
        body_text: res.body.body_text,
        body_html: res.body.body_html,
        ai_summary: res.body.ai_summary,
        classification_reason: res.body.classification_reason,
      } as unknown as Email;
    },
  });
  // Detail pane shows header + body. The on-demand full row carries
  // body_text / body_html / raw_labels (heavy fields we excluded from
  // the list query). The list row carries the freshest label /
  // classification state via realtime UPDATEs. Spread the full row FIRST
  // then the list row — list-row keys override, so label flips picked
  // up by realtime aren't masked by the stale full-row snapshot.
  const selected: Email | null = selectedFullQ.data
    ? selectedListItem
      ? { ...selectedFullQ.data, ...selectedListItem }
      : selectedFullQ.data
    : selectedListItem;

  const syncMut = useMutation({
    mutationFn: async () => {
      if (!accountId) throw new Error("Connect Gmail in Settings first");
      syncInFlightRef.current = true;
      // The DB is the source of truth and is kept current by the webhook +
      // background crons, so always refresh from it first — this is fast and
      // reliable and means the list updates even if the Gmail round-trip below
      // flakes out.
      await Promise.all([
        qc.refetchQueries({ queryKey: ["emails"] }),
        qc.invalidateQueries({ queryKey: ["folders"] }),
        qc.invalidateQueries({ queryKey: ["gmail-accounts"] }),
      ]);
      // Best-effort Gmail sync. Race against a timeout and retry once so a slow
      // or dropped request (Safari surfaces this as "Load failed") doesn't turn
      // into a scary error toast — the DB refresh above already happened.
      const TIMEOUT_MS = 20_000;
      const runOnce = () =>
        new Promise<Awaited<ReturnType<typeof sync>> | null>((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve(null);
            }
          }, TIMEOUT_MS);
          sync({ data: { account_id: accountId } })
            .then((r) => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(r);
              }
            })
            .catch(() => {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(null);
              }
            });
        });
      let res = await runOnce();
      if (res === null) res = await runOnce();
      syncInFlightRef.current = false;
      return res;
    },
    onSuccess: async (res) => {
      // res === null means the Gmail sync didn't complete (timeout/network),
      // but the DB refresh in mutationFn already updated the list. Stay quiet.
      if (!res) {
        const fresh =
          qc.getQueriesData<Email[]>({ queryKey: ["emails"] }).flatMap(([, d]) => d ?? []) ?? [];
        if (selectedId && !fresh.some((e) => e.id === selectedId)) setSelectedId(null);
        return;
      }
      const r = res?.reconciled;
      const synced = res && "synced" in res ? res.synced : undefined;
      const error = res && "error" in res ? res.error : undefined;
      const parts: string[] = [];
      if (typeof synced === "number" && synced > 0) parts.push(`${synced} new`);
      if (r?.archived) parts.push(`${r.archived} archived`);
      if (r?.deleted) parts.push(`${r.deleted} removed`);
      if (r?.failed) parts.push(`${r.failed} failed`);
      const msg = parts.length ? `Synced · ${parts.join(", ")}` : "Synced";
      if (error) toast.error(`Sync error: ${error}`);
      else toast.success(msg);
      await qc.refetchQueries({ queryKey: ["emails"] });
      const fresh =
        qc.getQueriesData<Email[]>({ queryKey: ["emails"] }).flatMap(([, d]) => d ?? []) ?? [];
      if (selectedId && !fresh.some((e) => e.id === selectedId)) setSelectedId(null);
    },
    onError: (e) => {
      syncInFlightRef.current = false;
      toast.error(e instanceof Error ? e.message : "Couldn't refresh. Please try again.");
    },
  });

  const headerLabel = labelForFolder(selectedFolder, foldersQ.data ?? []);

  // The only blocking state is a genuine cold DB read with nothing to paint yet
  // (no in-memory rows and no metadata-cache placeholder). It shows a brief
  // skeleton and never waits on Gmail. An in-flight background sync is signalled
  // only by the subtle header pulse.
  const coldLoading = emailsQ.isLoading && rawEmails.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col md:grid md:grid-cols-[400px_1fr]">
      {/* List */}
      <div
        className={`h-full min-h-0 flex-col overflow-hidden border-r border-border ${selected && selectedListItem ? "hidden md:flex" : "flex"}`}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="truncate font-display text-xl">{headerLabel}</h2>
            <span className="shrink-0 text-xs text-muted-foreground">{filtered.length}</span>
            {(syncMut.isPending || bgSyncing) && (
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground animate-pulse">
                Syncing…
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => setAssistantOpen(true)}
              title="Ask AI assistant"
            >
              <Sparkles className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => syncMut.mutate()}
              disabled={syncMut.isPending}
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${syncMut.isPending ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
        <div className="shrink-0 border-b border-border px-3 py-2">
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
              {gmailSearching ? "Checking Gmail…" : `Searching ${headerLabel}`}
            </div>
          )}
          {isSearching && lastGmailResult?.reason === "reauth_required" && (
            <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Gmail needs to be reconnected before search can pull older mail.{" "}
              <Link to="/settings" className="font-medium underline">
                Reconnect in Settings
              </Link>
            </div>
          )}
        </div>
        {isNoRules && (
          <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-2">
            {selectedIds.size === 0 ? (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Select emails to re-classify or group into a new folder.</span>
                <button
                  type="button"
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={() => setSelectedIds(new Set(filtered.map((e) => e.id)))}
                  disabled={filtered.length === 0}
                >
                  Select all
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium">{selectedIds.size} selected</span>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground hover:underline"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    Clear
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={reclassifyBusy}
                    onClick={async () => {
                      const ids = Array.from(selectedIds);
                      setReclassifyBusy(true);
                      try {
                        const r = await reclassifyFn({ data: { email_ids: ids } });
                        toast.success(
                          `Re-classified · ${r?.routed ?? 0} routed, ${r?.unchanged ?? 0} unchanged${r?.failed ? `, ${r.failed} failed` : ""}`,
                        );
                        setSelectedIds(new Set());
                        qc.invalidateQueries({ queryKey: ["emails"] });
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Re-classify failed");
                      } finally {
                        setReclassifyBusy(false);
                      }
                    }}
                  >
                    <RotateCw
                      className={`mr-1.5 h-3.5 w-3.5 ${reclassifyBusy ? "animate-spin" : ""}`}
                    />
                    Re-classify
                  </Button>
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={suggestBusy}
                    onClick={async () => {
                      const ids = Array.from(selectedIds);
                      setSuggestBusy(true);
                      try {
                        const s = await suggestFolderFn({ data: { email_ids: ids } });
                        setSuggestion({
                          name: s.name,
                          color: s.color,
                          ai_rule: s.ai_rule,
                          filter_field: s.filter_field || null,
                          filter_op: s.filter_op || null,
                          filter_value: s.filter_value || "",
                          why: s.why,
                          email_ids: ids,
                        });
                      } catch (err) {
                        toast.error(
                          err instanceof Error ? err.message : "Couldn't suggest a folder",
                        );
                      } finally {
                        setSuggestBusy(false);
                      }
                    }}
                  >
                    <Sparkles
                      className={`mr-1.5 h-3.5 w-3.5 ${suggestBusy ? "animate-pulse" : ""}`}
                    />
                    Suggest folder
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
        <PullToRefresh
          className="min-h-0 flex-1 overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedId(null);
          }}
          onRefresh={async () => {
            await Promise.all([
              qc.invalidateQueries({ queryKey: ["emails"] }),
              qc.invalidateQueries({ queryKey: ["folders"] }),
            ]);
          }}
        >
          {coldLoading && (
            <div className="divide-y divide-border" aria-hidden>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="space-y-2 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-10 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          )}
          {!emailsQ.isLoading && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 p-12 text-center text-muted-foreground">
              <img
                src={cobwebInbox}
                alt="Empty inbox illustration"
                className="h-32 w-auto opacity-90"
              />
              {isSearching ? (
                gmailSearching ? (
                  <p className="text-sm">Checking Gmail for "{query.trim()}"…</p>
                ) : lastGmailResult?.reason === "no_account" ? (
                  <>
                    <p className="text-sm">No matches found.</p>
                    <p className="text-xs">
                      Connect a Gmail account in Settings to search your full mailbox.
                    </p>
                  </>
                ) : lastGmailResult?.reason === "reauth_required" ? (
                  <>
                    <p className="text-sm">Gmail needs to be reconnected.</p>
                    <p className="text-xs">
                      Open Settings → Gmail to reauthorize, then search again.
                    </p>
                  </>
                ) : lastGmailResult?.reason === "rate_limited" ? (
                  <>
                    <p className="text-sm">Gmail is rate-limiting search right now.</p>
                    <p className="text-xs">
                      {lastGmailResult.found
                        ? `Found ${lastGmailResult.found} match${lastGmailResult.found === 1 ? "" : "es"} in Gmail — wait ~1 minute and search again to pull them in.`
                        : "Wait about a minute and try the search again."}
                    </p>
                  </>
                ) : (lastGmailResult?.found ?? 0) > 0 ? (
                  <>
                    <p className="text-sm">
                      Pulling {lastGmailResult!.found} match
                      {lastGmailResult!.found === 1 ? "" : "es"} from Gmail…
                    </p>
                    <p className="text-xs">Results will appear in a moment.</p>
                  </>
                ) : (
                  <>
                    <p className="text-sm">
                      No matches in your inbox or Gmail for "{query.trim()}".
                    </p>
                    <p className="text-xs">Try a different search term.</p>
                  </>
                )
              ) : (
                <>
                  <p className="text-sm">Nothing here yet.</p>
                  <p className="text-xs">Hit refresh, or connect Gmail in Settings.</p>
                </>
              )}
            </div>
          )}

          {filtered.map((e) => {
            const domain = e.from_addr?.includes("@")
              ? (e.from_addr.split("@")[1]?.toLowerCase() ?? null)
              : null;
            const folderList = foldersQ.data ?? [];
            const currentFolderId = e.folder_id;
            const showFolderPill =
              (selectedFolder === "all" || selectedFolder === "all_mail") && !isSearching;
            const rowFolder =
              showFolderPill && e.folder_id ? folderList.find((f) => f.id === e.folder_id) : null;
            const isChecked = selectedIds.has(e.id);
            const toggleCheck = () => {
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(e.id)) next.delete(e.id);
                else next.add(e.id);
                return next;
              });
            };

            const RowTag = isNoRules ? "div" : "button";
            const rowInner = (
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <RowTag
                    role={isNoRules ? "button" : undefined}
                    tabIndex={isNoRules ? 0 : undefined}
                    onClick={() => {
                      if (isNoRules) {
                        toggleCheck();
                        return;
                      }
                      setSelectedId(e.id);
                    }}
                    className={`relative block w-full ${isNoRules ? "pl-9 pr-4" : "px-4"} py-2 text-left transition-colors hover:bg-accent/50 ${selectedId === e.id ? "bg-accent" : ""} ${isChecked ? "bg-accent/60" : ""}`}
                  >
                    {isNoRules && (
                      <div
                        className="absolute left-3 top-1/2 -translate-y-1/2"
                        onClick={(ev) => ev.stopPropagation()}
                      >
                        <Checkbox checked={isChecked} onCheckedChange={() => toggleCheck()} />
                      </div>
                    )}
                    {!e.is_read && !isNoRules && (
                      <span
                        className="absolute left-1.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary"
                        aria-hidden
                      />
                    )}
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className={`truncate text-sm text-foreground ${e.is_read ? "font-medium" : "font-semibold"}`}
                      >
                        {e.__placeholder ? (
                          <span className="inline-block h-3.5 w-32 animate-pulse rounded bg-muted align-middle" />
                        ) : (
                          decodeEntities(e.from_name) || e.from_addr || "Unknown"
                        )}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {e.received_at
                          ? formatDistanceToNow(new Date(e.received_at), { addSuffix: false })
                          : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div
                        className={`min-w-0 flex-1 truncate text-sm ${e.is_read ? "text-foreground/85" : "text-foreground"}`}
                      >
                        {e.__placeholder ? (
                          <span className="inline-block h-3.5 w-3/4 max-w-full animate-pulse rounded bg-muted align-middle" />
                        ) : (
                          decodeEntities(e.subject) || "(no subject)"
                        )}
                      </div>
                      {rowFolder && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: rowFolder.color }}
                            aria-hidden
                          />
                          <span className="max-w-[80px] truncate">{rowFolder.name}</span>
                        </span>
                      )}
                    </div>
                    {e.__placeholder ? (
                      <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-muted" />
                    ) : e.ai_summary ? (
                      <div className="mt-1 flex items-start gap-1.5 text-xs text-primary/90">
                        <Sparkles className="mt-0.5 h-3 w-3 shrink-0" />
                        <span className="line-clamp-1">{decodeEntities(e.ai_summary)}</span>
                      </div>
                    ) : (
                      <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                        {decodeEntities(e.snippet)}
                      </div>
                    )}
                  </RowTag>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-64">
                  {(e.is_archived || e.folder_id || !(e.raw_labels ?? []).includes("INBOX")) && (
                    <>
                      <ContextMenuItem
                        onSelect={async () => {
                          qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                            prev?.map((x) =>
                              x.id === e.id
                                ? {
                                    ...x,
                                    folder_id: null,
                                    is_archived: false,
                                    raw_labels: withInbox(x.raw_labels),
                                    classified_by: "manual_inbox",
                                  }
                                : x,
                            ),
                          );
                          try {
                            await moveInboxFn({ data: { email_id: e.id } });
                            toast.success("Moved to inbox");
                            qc.invalidateQueries({ queryKey: ["emails"] });
                          } catch (err) {
                            qc.invalidateQueries({ queryKey: ["emails"] });
                            toast.error(errMsg(err));
                          }
                        }}
                      >
                        <Inbox className="mr-2 h-4 w-4" />
                        Move to Inbox
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                    </>
                  )}

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
                              qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                                prev?.map((x) =>
                                  x.id === e.id
                                    ? {
                                        ...x,
                                        folder_id: null,
                                        is_archived: false,
                                        raw_labels: withInbox(x.raw_labels),
                                        classified_by: "manual_inbox",
                                      }
                                    : x,
                                ),
                              );
                              try {
                                await moveInboxFn({ data: { email_id: e.id } });
                                toast.success("Moved to inbox");
                                qc.invalidateQueries({ queryKey: ["emails"] });
                              } catch (err) {
                                qc.invalidateQueries({ queryKey: ["emails"] });
                                toast.error(errMsg(err));
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
                      {folderList
                        .filter((f) => f.id !== currentFolderId)
                        .map((f) => (
                          <ContextMenuItem
                            key={f.id}
                            onSelect={async () => {
                              // Optimistically remove from any view that wouldn't show an archived row in this folder.
                              qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                                prev?.flatMap((x) => {
                                  if (x.id !== e.id) return [x];
                                  // Drop from Inbox-style views (is_archived=false filter) and from other folder views.
                                  return [
                                    {
                                      ...x,
                                      folder_id: f.id,
                                      is_archived: true,
                                      raw_labels: withoutInbox(x.raw_labels),
                                      classified_by: "manual_move",
                                    },
                                  ];
                                }),
                              );
                              qc.setQueriesData<Email[]>({ queryKey: ["emails", "all"] }, (prev) =>
                                prev?.filter((x) => x.id !== e.id),
                              );
                              try {
                                await moveFolderFn({
                                  data: { email_id: e.id, to_folder_id: f.id },
                                });
                                toast.success(`Moved to ${f.name}`);
                                // Defer refetch so the server-side Gmail label sync settles
                                // before a stale reconcile flips is_archived back to false.
                                setTimeout(
                                  () => qc.invalidateQueries({ queryKey: ["emails"] }),
                                  1500,
                                );
                              } catch (err) {
                                qc.invalidateQueries({ queryKey: ["emails"] });
                                toast.error(errMsg(err));
                              }
                            }}
                          >
                            <span
                              className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                              style={{ background: f.color }}
                            />
                            <span className="truncate">{f.name}</span>
                          </ContextMenuItem>
                        ))}
                    </ContextMenuSubContent>
                  </ContextMenuSub>

                  {(e.from_addr || domain || e.subject) && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onSelect={() =>
                          setFilterPrompt({
                            fromAddr: e.from_addr,
                            subject: e.subject,
                            currentFolderId: e.folder_id ?? null,
                          })
                        }
                      >
                        <FilterIcon className="mr-2 h-4 w-4" />
                        Filter messages like this…
                      </ContextMenuItem>
                    </>
                  )}

                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={async () => {
                      qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                        prev?.map((x) =>
                          x.id === e.id
                            ? { ...x, is_archived: true, raw_labels: withoutInbox(x.raw_labels) }
                            : x,
                        ),
                      );
                      try {
                        await archFnList({ data: { id: e.id } });
                        toast.success("Archived");
                      } catch (err) {
                        qc.invalidateQueries({ queryKey: ["emails"] });
                        toast.error(errMsg(err));
                      }
                    }}
                  >
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </ContextMenuItem>
                  <ContextMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={async () => {
                      qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                        prev?.filter((x) => x.id !== e.id),
                      );
                      try {
                        await trashFnList({ data: { id: e.id } });
                        toast.success("Trashed");
                      } catch (err) {
                        qc.invalidateQueries({ queryKey: ["emails"] });
                        toast.error(errMsg(err));
                      }
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Trash
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );

            return isNoRules ? (
              <div key={e.id}>{rowInner}</div>
            ) : (
              <SwipeRow
                key={e.id}
                onArchive={async () => {
                  qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                    prev?.filter((x) => x.id !== e.id),
                  );
                  try {
                    await archFnList({ data: { id: e.id } });
                    toast.success("Archived");
                  } catch (err) {
                    qc.invalidateQueries({ queryKey: ["emails"] });
                    toast.error(errMsg(err));
                  }
                }}
              >
                {rowInner}
              </SwipeRow>
            );
          })}
        </PullToRefresh>
        {(!isSearching || page > 1 || hasMoreSearch) && (
          <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={goPrev}
              disabled={page === 1}
            >
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
              title={
                !canGoNext
                  ? "No more results in this view"
                  : !isSearching && !hasMoreLocal
                    ? "Pull next 50 from Gmail"
                    : ""
              }
            >
              Next <ChevronLeft className="ml-1 h-3.5 w-3.5 rotate-180" />
            </Button>
          </div>
        )}
      </div>

      {/* Reading pane */}
      <div className={`h-full min-h-0 overflow-hidden ${selected ? "block" : "hidden md:block"}`}>
        {selected ? (
          <Reader
            key={selected.id}
            email={selected}
            folders={foldersQ.data ?? []}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <TrackingStandby />
        )}
      </div>

      {filterPrompt && (
        <FilterLikeThisDrawer
          open={!!filterPrompt}
          onOpenChange={(v) => {
            if (!v) setFilterPrompt(null);
          }}
          accountId={accountId}
          fromAddr={filterPrompt.fromAddr}
          subject={filterPrompt.subject}
          folders={foldersQ.data ?? []}
          currentFolderId={filterPrompt.currentFolderId}
        />
      )}

      <AssistantPanel
        open={assistantOpen}
        onOpenChange={setAssistantOpen}
        accountId={accountId}
        folders={(foldersQ.data ?? []).map((f) => ({ id: f.id, name: f.name }))}
        selectedEmails={(() => {
          const ids =
            selectedIds.size > 0 ? Array.from(selectedIds) : selected ? [selected.id] : [];
          return ids
            .map(
              (id) => filtered.find((e) => e.id === id) ?? (selected?.id === id ? selected : null),
            )
            .filter((e): e is Email => !!e)
            .map((e) => ({
              id: e.id,
              from_name: e.from_name,
              from_addr: e.from_addr,
              subject: e.subject,
            }));
        })()}
      />

      <Dialog
        open={!!suggestion}
        onOpenChange={(v) => {
          if (!v) setSuggestion(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create folder from selection</DialogTitle>
            <DialogDescription>{suggestion?.why}</DialogDescription>
          </DialogHeader>
          {suggestion && (
            <div className="space-y-3 text-sm">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Folder name
                </label>
                <Input
                  value={suggestion.name}
                  onChange={(ev) => setSuggestion({ ...suggestion, name: ev.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  AI rule
                </label>
                <Textarea
                  rows={3}
                  value={suggestion.ai_rule}
                  onChange={(ev) => setSuggestion({ ...suggestion, ai_rule: ev.target.value })}
                />
              </div>
              {suggestion.filter_field && suggestion.filter_op && suggestion.filter_value && (
                <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  Filter:{" "}
                  <span className="font-mono">
                    {suggestion.filter_field} {suggestion.filter_op} "{suggestion.filter_value}"
                  </span>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                {suggestion.email_ids.length} selected email
                {suggestion.email_ids.length === 1 ? "" : "s"} will be moved into this folder.
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSuggestion(null)}>
              Cancel
            </Button>
            <Button
              disabled={!suggestion?.name.trim() || !accountId}
              onClick={async () => {
                if (!suggestion || !accountId) return;
                try {
                  await createFolderAndAssignFn({
                    data: {
                      account_id: accountId,
                      name: suggestion.name.trim(),
                      color: suggestion.color,
                      ai_rule: suggestion.ai_rule,
                      filter:
                        suggestion.filter_field && suggestion.filter_op && suggestion.filter_value
                          ? {
                              field: suggestion.filter_field,
                              op: suggestion.filter_op,
                              value: suggestion.filter_value,
                            }
                          : null,
                      email_ids: suggestion.email_ids,
                    },
                  });
                  toast.success(`Folder "${suggestion.name}" created`);
                  setSuggestion(null);
                  setSelectedIds(new Set());
                  qc.invalidateQueries({ queryKey: ["folders"] });
                  qc.invalidateQueries({ queryKey: ["emails"] });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to create folder");
                }
              }}
            >
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function labelForFolder(sel: string | "all" | "all_mail" | "no_rules", folders: Folder[]) {
  if (sel === "all") return "All inbox";
  if (sel === "all_mail") return "All mail";
  if (sel === "no_rules") return "No rules";
  return folders.find((f) => f.id === sel)?.name ?? "Folder";
}

function Reader({
  email,
  folders,
  onBack,
}: {
  email: Email;
  folders: Folder[];
  onBack?: () => void;
}) {
  const isMobile = useIsMobile();
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
  const addContactFn = useServerFn(addContactFromEmail);
  const [resyncing, setResyncing] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [alwaysInbox, setAlwaysInbox] = useState<null | {
    fromAddr: string | null;
    domain: string | null;
  }>(null);
  const [reply, setReply] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [moving, setMoving] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
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
        supabase
          .from("folders")
          .select("id, name, ai_rule, gmail_label_id, filter_tree")
          .eq("id", email.folder_id!)
          .maybeSingle(),
        supabase
          .from("folder_filters")
          .select("id, field, op, value")
          .eq("folder_id", email.folder_id!),
      ]);
      return {
        folder: folderRes.data as {
          id: string;
          name: string;
          ai_rule: string | null;
          gmail_label_id: string | null;
          filter_tree: RuleNode | null;
        } | null,
        filters: (filtersRes.data ?? []) as Array<{
          id: string;
          field: string;
          op: string;
          value: string;
        }>,
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
      prev?.map((e) =>
        e.id === email.id
          ? {
              ...e,
              folder_id: target.id,
              is_archived: true,
              raw_labels: withoutInbox(e.raw_labels),
            }
          : e,
      ),
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
    } catch (e) {
      qc.invalidateQueries({ queryKey: ["emails"] });
      toast.error(errMsg(e));
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && (
            <button
              onClick={onBack}
              className="grid h-8 w-8 place-items-center rounded-md hover:bg-accent md:hidden"
              aria-label="Back"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          {folder && (
            <Badge variant="outline" className="hidden gap-1.5 md:inline-flex">
              <span className="h-2 w-2 rounded-full" style={{ background: folder.color }} />
              {folder.name}
            </Badge>
          )}
          {email.ai_confidence != null && email.ai_summary && (
            <Badge variant="outline" className="hidden gap-1 text-xs md:inline-flex">
              <Sparkles className="h-3 w-3" />
              AI · {Math.round(email.ai_confidence * 100)}%
            </Badge>
          )}
        </div>
        <div className="flex flex-nowrap gap-0.5 overflow-x-auto md:gap-1">
          <Button
            size="sm"
            variant="default"
            onClick={() => setReplyOpen(true)}
            className="h-8 px-2.5"
          >
            <Reply className="mr-1.5 h-3.5 w-3.5" />
            Reply
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
                  toast.message(
                    name
                      ? `No better folder — kept in ${name}.`
                      : "No better folder — kept current.",
                  );
                } else if (!r.changed) {
                  toast.success("Re-analyzed — no change");
                } else if (r.folder_id && r.folder_name) {
                  toast.success(`Re-analyzed → ${r.folder_name}`);
                } else {
                  toast.success("Re-analyzed → Inbox");
                }
              } catch (e) {
                toast.error(errMsg(e));
              } finally {
                setReanalyzing(false);
              }
            }}
          >
            <RotateCw className={`h-4 w-4 ${reanalyzing ? "animate-spin" : ""}`} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-1.5"
                disabled={moving}
                title="Move to folder"
              >
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
                        prev?.map((e) =>
                          e.id === email.id
                            ? {
                                ...e,
                                folder_id: null,
                                is_archived: false,
                                raw_labels: withInbox(e.raw_labels),
                              }
                            : e,
                        ),
                      );
                      try {
                        const r = await inboxFn({
                          data: { email_id: email.id, add_override: null },
                        });
                        qc.invalidateQueries({ queryKey: ["emails"] });
                        qc.invalidateQueries({ queryKey: ["emails-summary"] });
                        toast.success("Moved to Inbox");
                        if (r.from_addr || r.domain) {
                          setAlwaysInbox({ fromAddr: r.from_addr, domain: r.domain });
                        }
                      } catch (e) {
                        qc.invalidateQueries({ queryKey: ["emails"] });
                        toast.error(errMsg(e));
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
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => {
              const next = !email.is_read;
              qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                prev?.map((e) => (e.id === email.id ? { ...e, is_read: next } : e)),
              );
              markFn({ data: { id: email.id, read: next } }).catch(() =>
                qc.invalidateQueries({ queryKey: ["emails"] }),
              );
            }}
          >
            {email.is_read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={async () => {
              qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                prev?.map((e) =>
                  e.id === email.id
                    ? { ...e, is_archived: true, raw_labels: withoutInbox(e.raw_labels) }
                    : e,
                ),
              );
              try {
                await archFn({ data: { id: email.id } });
                toast.success("Archived");
              } catch (e) {
                qc.invalidateQueries({ queryKey: ["emails"] });
                toast.error(errMsg(e));
              }
            }}
          >
            <Archive className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={async () => {
              qc.setQueriesData<Email[]>({ queryKey: ["emails"] }, (prev) =>
                prev?.filter((e) => e.id !== email.id),
              );
              try {
                await trashFn({ data: { id: email.id } });
                toast.success("Trashed");
              } catch (e) {
                qc.invalidateQueries({ queryKey: ["emails"] });
                toast.error(errMsg(e));
              }
            }}
          >
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
                if ((r as { deleted?: boolean }).deleted)
                  toast.message("Removed — no longer in Gmail");
                else if ((r as { in_inbox?: boolean }).in_inbox)
                  toast.success("Resynced — back in Inbox");
                else toast.success("Resynced from Gmail");
              } catch (e) {
                toast.error(errMsg(e));
              } finally {
                setResyncing(false);
              }
            }}
          >
            <RefreshCw className={`h-4 w-4 ${resyncing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3 md:px-6">
        <h1 className="font-display text-lg leading-tight line-clamp-3 md:line-clamp-none md:text-2xl">
          {email.subject || "(no subject)"}
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-muted-foreground">
          <strong className="text-foreground">{email.from_name || email.from_addr}</strong>
          {email.from_name && email.from_addr ? (
            <span className="hidden md:inline">{` <${email.from_addr}>`}</span>
          ) : null}
          {email.received_at && (
            <span>{` · ${new Date(email.received_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}</span>
          )}
          {email.from_addr && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-1 h-6 gap-1 px-2 text-xs"
              disabled={addingContact}
              onClick={async () => {
                setAddingContact(true);
                try {
                  const r = await addContactFn({ data: { emailId: email.id } });
                  qc.invalidateQueries({ queryKey: ["contacts"] });
                  if (!r.contact) {
                    toast.success("Added to contacts");
                  } else {
                    toast.success(
                      <span>
                        Added <strong>{r.contact.name || r.contact.email}</strong> to contacts ·{" "}
                        <Link
                          to="/contacts/$id"
                          params={{ id: r.contact.id }}
                          className="underline"
                        >
                          View
                        </Link>
                      </span>,
                    );
                  }
                } catch (e) {
                  toast.error(errMsg(e));
                } finally {
                  setAddingContact(false);
                }
              }}
            >
              <UserPlus className={`h-3.5 w-3.5 ${addingContact ? "animate-pulse" : ""}`} />
              {addingContact ? "Adding…" : "Add contact"}
            </Button>
          )}
        </p>
        {email.ai_summary && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-sm">
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              <span className="font-medium text-primary">Summary · </span>
              {email.ai_summary}
            </span>
          </div>
        )}

        <Collapsible open={whyOpen} onOpenChange={setWhyOpen} className="mt-1.5">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between rounded-md border border-border bg-card/30 px-3 py-1 text-left text-sm hover:bg-accent/40">
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <HelpCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {(() => {
                  const currentFolder = email.folder_id
                    ? folders.find((f) => f.id === email.folder_id)
                    : null;
                  if (currentFolder) {
                    return (
                      <>
                        <span className="hidden shrink-0 text-muted-foreground sm:inline">In</span>
                        <span
                          className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
                          title={currentFolder.name}
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: currentFolder.color }}
                          />
                          <span className="truncate">{currentFolder.name}</span>
                        </span>
                      </>
                    );
                  }
                  return <span className="truncate text-muted-foreground">Why this folder?</span>;
                })()}
                <ClassifiedChip by={email.classified_by} />
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${whyOpen ? "rotate-180" : ""}`}
              />
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
            {(() => {
              const winnerId = email.folder_id;
              const others = (email.matched_folder_ids ?? [])
                .filter((id) => id !== winnerId)
                .map((id) => folders.find((f) => f.id === id))
                .filter((f): f is Folder => !!f);
              if (others.length === 0) return null;
              return (
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                    Also matched
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {others.map((f) => (
                      <span
                        key={f.id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
                        title={`${f.name} rules also matched — lost on priority`}
                      >
                        <span className="h-2 w-2 rounded-full" style={{ background: f.color }} />
                        <span className="truncate max-w-[10rem]">{f.name}</span>
                      </span>
                    ))}
                    <span className="text-xs text-muted-foreground self-center">
                      · winner chosen by priority
                    </span>
                  </div>
                </div>
              );
            })()}
            {email.classified_by === "ai" && email.ai_confidence != null && (
              <div>
                <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                  AI confidence
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${Math.round(email.ai_confidence * 100)}%` }}
                  />
                </div>
              </div>
            )}
            {email.processed_at && email.received_at && (
              <div className="text-xs text-muted-foreground">
                Synced{" "}
                {(() => {
                  const delta = Math.max(
                    0,
                    Math.round(
                      (new Date(email.processed_at).getTime() -
                        new Date(email.received_at).getTime()) /
                        1000,
                    ),
                  );
                  if (delta < 90) return `${delta}s`;
                  if (delta < 3600) return `${Math.round(delta / 60)} min`;
                  return `${Math.round(delta / 3600)}h`;
                })()}{" "}
                after Gmail received it
                {email.processed_at && <> · {new Date(email.processed_at).toLocaleString()}</>}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>

        <div className="mt-4">
          {email.body_html && hasVisibleHtml(email.body_html) ? (
            isMobile ? (
              <EmailBodyInline key={email.id} html={email.body_html} />
            ) : (
              <EmailBodyFrame key={email.id} html={email.body_html} />
            )
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
              {email.body_text || email.snippet || ""}
            </pre>
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
            <Button
              size="sm"
              variant="ghost"
              disabled={generating}
              onClick={async () => {
                setGenerating(true);
                try {
                  const r = await genFn({ data: { id: email.id } });
                  setReply(r.draft);
                } catch (e) {
                  toast.error(errMsg(e));
                }
                setGenerating(false);
              }}
            >
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              {generating ? "Drafting…" : "Suggest reply"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReplyOpen(false)}
              aria-label="Close reply"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="p-4">
          <Textarea
            rows={6}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Write a reply…"
            autoFocus={replyOpen}
          />
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              disabled={!reply.trim() || sending}
              onClick={async () => {
                setSending(true);
                try {
                  await sendFn({ data: { id: email.id, body: reply } });
                  toast.success("Sent");
                  setReply("");
                  setReplyOpen(false);
                } catch (e) {
                  toast.error(errMsg(e));
                }
                setSending(false);
              }}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              Send
            </Button>
          </div>
        </div>
      </div>

      {similarPrompt && (
        <MoveSimilarDialog
          open={!!similarPrompt}
          onOpenChange={(v) => {
            if (!v) setSimilarPrompt(null);
          }}
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
          onOpenChange={(v) => {
            if (!v) setAlwaysInbox(null);
          }}
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
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${v.cls}`}
    >
      <Icon className="h-3 w-3" /> {v.label}
    </span>
  );
}

function opLabel(op: string) {
  const m: Record<string, string> = {
    contains: "contains",
    equals: "equals",
    starts_with: "starts with",
    ends_with: "ends with",
    regex: "matches regex",
    not_contains: "does not contain",
    not_equals: "does not equal",
  };
  return m[op] ?? op;
}

// Mirror of applyFilter in src/lib/sync.server.ts — keep in sync.
function applyFilterClient(
  email: {
    from_addr: string | null;
    from_name: string | null;
    to_addrs: string | null;
    subject: string | null;
    body_text?: string | null;
    has_attachment: boolean;
  },
  f: { field: string; op: string; value: string },
): boolean {
  const v = (f.value || "").toLowerCase();
  const fieldVal = (() => {
    switch (f.field) {
      case "from":
        return `${email.from_addr ?? ""} ${email.from_name ?? ""}`.toLowerCase();
      case "to":
        return (email.to_addrs ?? "").toLowerCase();
      case "subject":
        return (email.subject ?? "").toLowerCase();
      case "body":
        return (email.body_text ?? "").toLowerCase();
      case "domain":
        return ((email.from_addr ?? "").split("@")[1] ?? "").toLowerCase();
      case "has_attachment":
        return email.has_attachment ? "true" : "false";
      default:
        return "";
    }
  })();
  switch (f.op) {
    case "contains":
      return fieldVal.includes(v);
    case "equals":
      return fieldVal === v;
    case "not_contains":
      return !fieldVal.includes(v);
    case "not_equals":
      return fieldVal !== v;
    case "regex":
      try {
        return new RegExp(f.value, "i").test(fieldVal);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

const EXCLUDE_OPS_CLIENT = new Set(["not_contains", "not_equals"]);

function TriggeredBy({
  classifiedBy,
  reason,
  folder,
  filters,
  email,
}: {
  classifiedBy: string | null;
  reason: string | null;
  folder: {
    id: string;
    name: string;
    ai_rule: string | null;
    gmail_label_id: string | null;
    filter_tree: RuleNode | null;
  } | null;
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
    // Tree-based folder: re-evaluate the tree to pinpoint matching leaves.
    // Tree leaves have no folder_filters row id, so synthesize entries.
    if (folder?.filter_tree) {
      const emailForFilter = {
        from_addr: email.from_addr ?? "",
        from_name: email.from_name ?? "",
        to_addrs: email.to_addrs ?? "",
        subject: email.subject ?? "",
        body_text: email.body_text ?? "",
        has_attachment: email.has_attachment,
      };
      const leaves = collectMatchingLeaves(emailForFilter, folder.filter_tree);
      if (leaves.length > 0) {
        return {
          matched: leaves.map((l, i) => ({ id: `tree-${i}`, ...l })),
          rulesChanged: false,
        };
      }
    }
    // Legacy email: recompute the matching includes client-side.
    const includes = filters.filter((f) => !EXCLUDE_OPS_CLIENT.has(f.op));
    return { matched: includes.filter((f) => applyFilterClient(email, f)), rulesChanged: false };
  }, [by, email, filters, folder]);

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
              <li
                key={i}
                className="rounded border border-border bg-background/40 px-2 py-1 font-mono text-xs"
              >
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
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
              Folder AI prompt
            </div>
            <p className="rounded border border-border bg-background/40 px-2 py-1.5 text-foreground/90 italic">
              "{folder.ai_rule}"
            </p>
          </div>
        )}
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
            Why the AI picked this folder
          </div>
          {reason ? (
            <p className="text-foreground/90">{reason}</p>
          ) : (
            <p className="italic text-muted-foreground">
              No reasoning recorded for this email. Newly synced emails will include one.
            </p>
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
        <div className="text-xs uppercase tracking-wider text-destructive">
          Kept in inbox by exclude rule
        </div>
        <p className="text-foreground/90">
          {reason ?? "An exclude rule on a matching folder kept this email in your inbox."}
        </p>
      </div>
    );
  }

  if (by === "global_exclude") {
    return (
      <div className="space-y-1">
        <div className="text-xs uppercase tracking-wider text-destructive">
          Always send to inbox
        </div>
        <p className="text-foreground/90">
          {reason ??
            "This sender is on your global inbox list, so folder rules and AI sorting are skipped."}
        </p>
      </div>
    );
  }

  return <p className="italic text-muted-foreground">This email hasn't been classified yet.</p>;
}
