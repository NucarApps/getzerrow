// Core sync pipeline: pull a single message, apply filters/AI, persist, apply Gmail label/actions.
// Server-only. Used by initial backfill, polling, and the webhook handler.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessage, modifyMessage, parseMessage, listMessages, listHistory } from "./gmail.server";
import { classifyEmail } from "./ai.server";

type Folder = {
  id: string;
  name: string;
  gmail_label_id: string | null;
  ai_rule: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  priority: number;
};

type Filter = {
  folder_id: string;
  field: string;
  op: string;
  value: string;
};

function applyFilter(
  email: { from_addr: string; from_name: string; to_addrs: string; subject: string; body_text: string; has_attachment: boolean },
  f: Filter
): boolean {
  const v = f.value.toLowerCase();
  const fieldVal = (() => {
    switch (f.field) {
      case "from": return `${email.from_addr} ${email.from_name}`.toLowerCase();
      case "to": return (email.to_addrs || "").toLowerCase();
      case "subject": return (email.subject || "").toLowerCase();
      case "body": return (email.body_text || "").toLowerCase();
      case "domain": return (email.from_addr.split("@")[1] || "").toLowerCase();
      case "has_attachment": return email.has_attachment ? "true" : "false";
      default: return "";
    }
  })();
  switch (f.op) {
    case "contains": return fieldVal.includes(v);
    case "equals": return fieldVal === v;
    case "regex":
      try { return new RegExp(f.value, "i").test(fieldVal); } catch { return false; }
    default: return false;
  }
}

function matchByFilters(
  email: Parameters<typeof applyFilter>[0],
  folders: Folder[],
  filters: Filter[]
): string | null {
  // Group filters by folder; a folder matches if ANY of its filters match (OR within folder).
  const byFolder = new Map<string, Filter[]>();
  for (const f of filters) {
    if (!byFolder.has(f.folder_id)) byFolder.set(f.folder_id, []);
    byFolder.get(f.folder_id)!.push(f);
  }
  const matched: Folder[] = [];
  for (const folder of folders) {
    const fs = byFolder.get(folder.id) || [];
    if (fs.length === 0) continue;
    if (fs.some((f) => applyFilter(email, f))) matched.push(folder);
  }
  if (matched.length === 0) return null;
  matched.sort((a, b) => b.priority - a.priority);
  return matched[0].id;
}

export async function processGmailMessage(gmailId: string, userId: string) {
  // Skip if we already have it.
  const { data: existing } = await supabaseAdmin
    .from("emails")
    .select("id")
    .eq("gmail_message_id", gmailId)
    .maybeSingle();
  if (existing) return { skipped: true };

  const raw = await getMessage(gmailId);
  const parsed = parseMessage(raw);

  // Only handle inbox messages
  if (!parsed.raw_labels?.includes("INBOX")) return { skipped: true };

  const [{ data: folders }, { data: filters }] = await Promise.all([
    supabaseAdmin.from("folders").select("*").order("priority", { ascending: false }),
    supabaseAdmin.from("folder_filters").select("folder_id, field, op, value"),
  ]);

  const folderList = (folders ?? []) as Folder[];
  const filterList = (filters ?? []) as Filter[];

  let folder_id: string | null = matchByFilters(parsed, folderList, filterList);
  let confidence = folder_id ? 1 : 0;
  let summary = "";
  let classified_by: string = folder_id ? "filter" : "none";

  if (!folder_id && folderList.length > 0) {
    try {
      const r = await classifyEmail(parsed, folderList.map((f) => ({ id: f.id, name: f.name, ai_rule: f.ai_rule })));
      folder_id = r.folder_id;
      confidence = r.confidence;
      summary = r.summary;
      classified_by = "ai";
    } catch (e) {
      console.error("AI classify failed", e);
    }
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("emails")
    .insert({
      user_id: userId,
      gmail_message_id: parsed.gmail_message_id,
      thread_id: parsed.thread_id,
      from_addr: parsed.from_addr,
      from_name: parsed.from_name,
      to_addrs: parsed.to_addrs,
      subject: parsed.subject,
      snippet: parsed.snippet,
      body_text: parsed.body_text,
      body_html: parsed.body_html,
      received_at: parsed.received_at,
      is_read: parsed.is_read,
      has_attachment: parsed.has_attachment,
      raw_labels: parsed.raw_labels,
      folder_id,
      ai_summary: summary || null,
      ai_confidence: confidence,
      classified_by,
    })
    .select("id, folder_id")
    .single();

  if (error) {
    console.error("insert email failed", error);
    return { error: error.message };
  }

  // Apply Gmail-side actions
  if (folder_id) {
    const folder = folderList.find((f) => f.id === folder_id);
    if (folder) {
      const addLabels: string[] = [];
      const removeLabels: string[] = [];
      if (folder.gmail_label_id) addLabels.push(folder.gmail_label_id);
      if (folder.auto_mark_read) removeLabels.push("UNREAD");
      if (folder.auto_archive) removeLabels.push("INBOX");
      if (addLabels.length || removeLabels.length) {
        try { await modifyMessage(gmailId, addLabels, removeLabels); } catch (e) { console.error("modify failed", e); }
      }
      if (folder.auto_archive) {
        await supabaseAdmin.from("emails").update({ is_archived: true }).eq("id", inserted.id);
      }
      if (folder.auto_mark_read) {
        await supabaseAdmin.from("emails").update({ is_read: true }).eq("id", inserted.id);
      }
    }
  }

  return { id: inserted.id };
}

export async function backfillRecent(userId: string, maxResults = 30) {
  const list = await listMessages({ maxResults, q: "in:inbox" });
  const ids = list.messages || [];
  const results: any[] = [];
  for (const m of ids) {
    try {
      const r = await processGmailMessage(m.id, userId);
      results.push(r);
    } catch (e: any) {
      results.push({ error: e.message });
    }
  }
  return { processed: results.length };
}

export async function syncSinceHistory(userId: string) {
  const { data: state } = await supabaseAdmin.from("sync_state").select("*").eq("id", 1).single();
  if (!state?.last_history_id) {
    // Bootstrap: do a recent backfill and set history id from latest message
    await backfillRecent(userId, 20);
    const recent = await listMessages({ maxResults: 1 });
    if (recent.messages?.[0]) {
      const m = await getMessage(recent.messages[0].id);
      await supabaseAdmin.from("sync_state").update({ last_history_id: m.historyId, last_poll_at: new Date().toISOString() }).eq("id", 1);
    }
    return { bootstrapped: true };
  }
  try {
    const hist = await listHistory(state.last_history_id);
    const seen = new Set<string>();
    for (const h of hist.history || []) {
      for (const m of h.messages || []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        try { await processGmailMessage(m.id, userId); } catch (e) { console.error(e); }
      }
    }
    if (hist.historyId) {
      await supabaseAdmin.from("sync_state").update({ last_history_id: hist.historyId, last_poll_at: new Date().toISOString() }).eq("id", 1);
    }
    return { synced: seen.size };
  } catch (e: any) {
    // History expired — re-bootstrap
    console.error("history failed, rebootstrapping", e.message);
    await supabaseAdmin.from("sync_state").update({ last_history_id: null }).eq("id", 1);
    return { error: e.message };
  }
}
