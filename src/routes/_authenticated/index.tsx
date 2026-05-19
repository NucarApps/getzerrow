import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  triggerSync, markEmailRead, archiveEmail, trashEmail, generateReply, sendReply,
} from "@/lib/gmail.functions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Archive, Trash2, RefreshCw, Mail, MailOpen, Send, Inbox } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

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
};

type Folder = { id: string; name: string; color: string };

function InboxPage() {
  const qc = useQueryClient();
  const sync = useServerFn(triggerSync);
  const [selectedFolder, setSelectedFolder] = useState<string | "all" | "unsorted">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
      const { data } = await supabase.from("emails").select("*").eq("is_archived", false).order("received_at", { ascending: false }).limit(300);
      return (data ?? []) as Email[];
    },
  });

  useEffect(() => {
    const ch = supabase
      .channel("emails-rt")
      .on("postgres_changes", { event: "*", schema: "public", table: "emails" }, () => {
        qc.invalidateQueries({ queryKey: ["emails"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "folders" }, () => {
        qc.invalidateQueries({ queryKey: ["folders"] });
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [qc]);

  const filtered = useMemo(() => {
    const all = emailsQ.data ?? [];
    if (selectedFolder === "all") return all;
    if (selectedFolder === "unsorted") return all.filter((e) => !e.folder_id);
    return all.filter((e) => e.folder_id === selectedFolder);
  }, [emailsQ.data, selectedFolder]);

  const selected = filtered.find((e) => e.id === selectedId) ?? null;

  const syncMut = useMutation({
    mutationFn: () => {
      if (!accountId) throw new Error("Connect Gmail in Settings first");
      return sync({ data: { account_id: accountId } });
    },
    onSuccess: () => { toast.success("Synced"); qc.invalidateQueries({ queryKey: ["emails"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  const counts = useMemo(() => {
    const all = emailsQ.data ?? [];
    const m = new Map<string, number>();
    for (const e of all) {
      if (e.is_read) continue;
      const k = e.folder_id ?? "unsorted";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [emailsQ.data]);

  return (
    <div className="grid h-screen grid-cols-[220px_360px_1fr]">
      {/* Folders pane */}
      <div className="overflow-y-auto border-r border-border bg-card/30 p-3">
        <div className="mb-3 flex items-center justify-between px-2">
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground">Folders</span>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => syncMut.mutate()} disabled={syncMut.isPending}>
            <RefreshCw className={`h-3.5 w-3.5 ${syncMut.isPending ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <FolderButton
          active={selectedFolder === "all"} onClick={() => setSelectedFolder("all")}
          color="#a3a3a3" label="All inbox" count={Array.from(counts.values()).reduce((a, b) => a + b, 0)}
        />
        <FolderButton
          active={selectedFolder === "unsorted"} onClick={() => setSelectedFolder("unsorted")}
          color="#71717a" label="Unsorted" count={counts.get("unsorted") ?? 0}
        />
        <div className="mt-3 border-t border-border pt-3">
          {(foldersQ.data ?? []).map((f) => (
            <FolderButton
              key={f.id}
              active={selectedFolder === f.id}
              onClick={() => setSelectedFolder(f.id)}
              color={f.color}
              label={f.name}
              count={counts.get(f.id) ?? 0}
            />
          ))}
          {(foldersQ.data ?? []).length === 0 && (
            <p className="px-2 py-4 text-xs text-muted-foreground">No folders yet. Create some in <a href="/folders" className="underline">Folders</a>.</p>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex flex-col overflow-hidden border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-display text-xl">{labelForFolder(selectedFolder, foldersQ.data ?? [])}</h2>
          <span className="text-xs text-muted-foreground">{filtered.length}</span>
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
      <div className="overflow-y-auto">
        {selected ? <Reader key={selected.id} email={selected} folders={foldersQ.data ?? []} /> : (
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

function FolderButton({ active, onClick, color, label, count }: { active: boolean; onClick: () => void; color: string; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"}`}
    >
      <span className="flex items-center gap-2 truncate">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate">{label}</span>
      </span>
      {count > 0 && <span className="rounded-full bg-primary/20 px-1.5 text-[10px] text-primary">{count}</span>}
    </button>
  );
}

function Reader({ email, folders }: { email: Email; folders: Folder[] }) {
  const qc = useQueryClient();
  const markFn = useServerFn(markEmailRead);
  const archFn = useServerFn(archiveEmail);
  const trashFn = useServerFn(trashEmail);
  const genFn = useServerFn(generateReply);
  const sendFn = useServerFn(sendReply);
  const [reply, setReply] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!email.is_read) {
      markFn({ data: { id: email.id, read: true } }).then(() => qc.invalidateQueries({ queryKey: ["emails"] }));
    }
  }, [email.id]); // eslint-disable-line

  const folder = folders.find((f) => f.id === email.folder_id);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-6 py-3">
        <div className="flex items-center gap-2">
          {folder && <Badge variant="outline" className="gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: folder.color }} />{folder.name}</Badge>}
          {email.ai_confidence != null && email.ai_summary && (
            <Badge variant="outline" className="gap-1 text-xs"><Sparkles className="h-3 w-3" />AI · {Math.round(email.ai_confidence * 100)}%</Badge>
          )}
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => markFn({ data: { id: email.id, read: !email.is_read } }).then(() => qc.invalidateQueries({ queryKey: ["emails"] }))}>
            {email.is_read ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={async () => { await archFn({ data: { id: email.id } }); qc.invalidateQueries({ queryKey: ["emails"] }); toast.success("Archived"); }}>
            <Archive className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={async () => { await trashFn({ data: { id: email.id } }); qc.invalidateQueries({ queryKey: ["emails"] }); toast.success("Trashed"); }}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <h1 className="font-display text-3xl leading-tight">{email.subject || "(no subject)"}</h1>
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
        <div className="prose prose-invert mt-6 max-w-none">
          {email.body_html ? (
            <div className="text-sm leading-relaxed [&_a]:text-primary" dangerouslySetInnerHTML={{ __html: email.body_html }} />
          ) : (
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{email.body_text}</pre>
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
    </div>
  );
}
