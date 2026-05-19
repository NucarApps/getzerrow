// Core sync pipeline: pull messages for a specific gmail_account, apply filters/AI,
// persist, apply Gmail label/actions. Server-only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessage, modifyMessage, parseMessage, listMessages, listHistory, ensureWatch } from "./gmail.server";
import { classifyEmail, buildFolderProfile, type ClassifyFolder } from "./ai.server";

type Folder = {
  id: string;
  name: string;
  gmail_label_id: string | null;
  ai_rule: string | null;
  learned_profile: string | null;
  last_learned_at: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  priority: number;
  gmail_account_id: string;
};

type Filter = { folder_id: string; field: string; op: string; value: string };

type GmailAccount = {
  id: string;
  user_id: string;
  email_address: string;
  history_id: string | null;
  watch_expiration: string | null;
};

async function getAccount(accountId: string): Promise<GmailAccount> {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id, email_address, history_id, watch_expiration")
    .eq("id", accountId)
    .single();
  if (error || !data) throw new Error("Gmail account not found");
  return data as GmailAccount;
}

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

function matchByFilters(email: Parameters<typeof applyFilter>[0], folders: Folder[], filters: Filter[]): string | null {
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

async function loadFoldersWithExamples(folders: Folder[]): Promise<ClassifyFolder[]> {
  if (folders.length === 0) return [];
  const { data: examples } = await supabaseAdmin
    .from("folder_examples")
    .select("folder_id, from_addr, subject")
    .in("folder_id", folders.map((f) => f.id))
    .order("created_at", { ascending: false })
    .limit(200);
  const byFolder = new Map<string, Array<{ from_addr: string | null; subject: string | null }>>();
  for (const e of examples ?? []) {
    if (!byFolder.has(e.folder_id)) byFolder.set(e.folder_id, []);
    const arr = byFolder.get(e.folder_id)!;
    if (arr.length < 5) arr.push({ from_addr: e.from_addr, subject: e.subject });
  }
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    ai_rule: f.ai_rule,
    learned_profile: f.learned_profile,
    examples: byFolder.get(f.id) ?? [],
  }));
}

export async function processGmailMessage(accountId: string, gmailId: string, userId: string) {
  const { data: existing } = await supabaseAdmin
    .from("emails")
    .select("id")
    .eq("gmail_message_id", gmailId)
    .eq("gmail_account_id", accountId)
    .maybeSingle();
  if (existing) return { skipped: true };

  const raw = await getMessage(accountId, gmailId);
  const parsed = parseMessage(raw);

  if (!parsed.raw_labels?.includes("INBOX")) return { skipped: true };

  const [{ data: folders }, { data: filters }] = await Promise.all([
    supabaseAdmin.from("folders").select("*").eq("gmail_account_id", accountId).order("priority", { ascending: false }),
    supabaseAdmin.from("folder_filters").select("folder_id, field, op, value"),
  ]);

  const folderList = (folders ?? []) as Folder[];
  const folderIds = new Set(folderList.map((f) => f.id));
  const filterList = ((filters ?? []) as Filter[]).filter((f) => folderIds.has(f.folder_id));

  let folder_id: string | null = null;
  let classified_by = "none";
  let confidence = 0;
  let summary = "";

  const labeledFolder = folderList.find((f) => f.gmail_label_id && parsed.raw_labels?.includes(f.gmail_label_id));
  if (labeledFolder) {
    folder_id = labeledFolder.id;
    classified_by = "gmail_label";
    confidence = 1;
  } else {
    folder_id = matchByFilters(parsed, folderList, filterList);
    if (folder_id) { classified_by = "filter"; confidence = 1; }
  }

  if (!folder_id && folderList.length > 0) {
    try {
      const enriched = await loadFoldersWithExamples(folderList);
      const r = await classifyEmail(parsed, enriched);
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
      gmail_account_id: accountId,
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

  if (folder_id) {
    const folder = folderList.find((f) => f.id === folder_id);
    if (folder) {
      const addLabels: string[] = [];
      const removeLabels: string[] = [];
      if (folder.gmail_label_id && !parsed.raw_labels?.includes(folder.gmail_label_id)) addLabels.push(folder.gmail_label_id);
      if (folder.auto_mark_read) removeLabels.push("UNREAD");
      if (folder.auto_archive) removeLabels.push("INBOX");
      if (addLabels.length || removeLabels.length) {
        try { await modifyMessage(accountId, gmailId, addLabels, removeLabels); } catch (e) { console.error("modify failed", e); }
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

async function recordManualMove(
  folder: Folder,
  accountId: string,
  userId: string,
  msg: { gmail_message_id: string; from_addr: string; subject: string; snippet: string }
) {
  const { error } = await supabaseAdmin.from("folder_examples").upsert(
    {
      folder_id: folder.id,
      gmail_account_id: accountId,
      user_id: userId,
      gmail_message_id: msg.gmail_message_id,
      from_addr: msg.from_addr,
      subject: msg.subject,
      snippet: msg.snippet,
      source: "manual_move",
    },
    { onConflict: "folder_id,gmail_message_id" }
  );
  if (error) console.error("example upsert failed", error);

  await supabaseAdmin
    .from("emails")
    .update({ folder_id: folder.id, classified_by: "manual_move", ai_confidence: 1 })
    .eq("gmail_message_id", msg.gmail_message_id)
    .eq("gmail_account_id", accountId);

  const since = folder.last_learned_at ?? "1970-01-01T00:00:00Z";
  const { count } = await supabaseAdmin
    .from("folder_examples")
    .select("id", { count: "exact", head: true })
    .eq("folder_id", folder.id)
    .eq("source", "manual_move")
    .gt("created_at", since);
  if ((count ?? 0) >= 3) {
    try { await regenerateFolderProfile(folder.id); } catch (e) { console.error("auto re-learn failed", e); }
  }
}

export async function regenerateFolderProfile(folderId: string) {
  const { data: folder } = await supabaseAdmin.from("folders").select("*").eq("id", folderId).single();
  if (!folder) return;
  const { data: examples } = await supabaseAdmin
    .from("folder_examples")
    .select("from_addr, subject, snippet")
    .eq("folder_id", folderId)
    .order("created_at", { ascending: false })
    .limit(50);
  const profile = await buildFolderProfile(folder.name, folder.ai_rule, examples ?? []);
  await supabaseAdmin
    .from("folders")
    .update({ learned_profile: profile, last_learned_at: new Date().toISOString() })
    .eq("id", folderId);
  return profile;
}

export async function learnFromLinkedLabel(folderId: string, userId: string) {
  const { data: folder } = await supabaseAdmin.from("folders").select("*").eq("id", folderId).single();
  if (!folder) throw new Error("Folder not found");
  if (folder.user_id !== userId) throw new Error("Not authorized");
  if (!folder.gmail_label_id) throw new Error("Folder is not linked to a Gmail label");
  const accountId = folder.gmail_account_id;

  const MAX_MESSAGES = 500;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const list = await listMessages(accountId, {
      maxResults: 100,
      labelIds: [folder.gmail_label_id],
      q: "newer_than:30d",
      pageToken,
    });
    for (const m of list.messages ?? []) ids.push(m.id);
    pageToken = list.nextPageToken;
    if (ids.length >= MAX_MESSAGES) break;
  } while (pageToken);

  let learned = 0;
  for (const id of ids.slice(0, MAX_MESSAGES)) {
    try {
      const raw = await getMessage(accountId, id);
      const p = parseMessage(raw);
      const { error } = await supabaseAdmin.from("folder_examples").upsert(
        {
          folder_id: folderId,
          gmail_account_id: accountId,
          user_id: userId,
          gmail_message_id: p.gmail_message_id,
          from_addr: p.from_addr,
          subject: p.subject,
          snippet: p.snippet,
          source: "seed",
        },
        { onConflict: "folder_id,gmail_message_id" }
      );
      if (!error) learned++;
    } catch (e) {
      console.error("seed example failed", e);
    }
  }
  const profile = await regenerateFolderProfile(folderId);
  return { learned, profile };
}

export async function backfillRecent(accountId: string, userId: string, maxResults = 30) {
  const list = await listMessages(accountId, { maxResults, q: "in:inbox" });
  const ids = list.messages || [];
  const results: any[] = [];
  for (const m of ids) {
    try {
      const r = await processGmailMessage(accountId, m.id, userId);
      results.push(r);
    } catch (e: any) {
      results.push({ error: e.message });
    }
  }
  return { processed: results.length };
}

async function bumpHistoryAndWatch(accountId: string, historyId: string) {
  const account = await getAccount(accountId);
  const watch = await ensureWatch(accountId, account.watch_expiration);
  if (watch) {
    await supabaseAdmin.from("gmail_accounts").update({
      history_id: watch.historyId,
      watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
      last_poll_at: new Date().toISOString(),
    }).eq("id", accountId);
  } else {
    await supabaseAdmin.from("gmail_accounts").update({
      history_id: historyId,
      last_poll_at: new Date().toISOString(),
    }).eq("id", accountId);
  }
}

export async function syncSinceHistory(accountId: string) {
  const account = await getAccount(accountId);
  if (!account.history_id) {
    await backfillRecent(accountId, account.user_id, 20);
    const recent = await listMessages(accountId, { maxResults: 1 });
    if (recent.messages?.[0]) {
      const m = await getMessage(accountId, recent.messages[0].id);
      await bumpHistoryAndWatch(accountId, m.historyId);
    }
    return { bootstrapped: true };
  }
  try {
    const hist = await listHistory(accountId, account.history_id);
    const seenAdded = new Set<string>();
    const { data: folders } = await supabaseAdmin.from("folders").select("*").eq("gmail_account_id", accountId);
    const folderList = (folders ?? []) as Folder[];
    const labelToFolder = new Map<string, Folder>();
    for (const f of folderList) if (f.gmail_label_id) labelToFolder.set(f.gmail_label_id, f);

    for (const h of hist.history || []) {
      const added = h.messagesAdded?.map((x) => x.message) ?? h.messages ?? [];
      for (const m of added) {
        if (seenAdded.has(m.id)) continue;
        seenAdded.add(m.id);
        try { await processGmailMessage(accountId, m.id, account.user_id); } catch (e) { console.error(e); }
      }
      for (const ev of h.labelsAdded ?? []) {
        const matched = ev.labelIds.map((l) => labelToFolder.get(l)).filter(Boolean) as Folder[];
        if (matched.length === 0) continue;
        try {
          const raw = await getMessage(accountId, ev.message.id);
          const p = parseMessage(raw);
          for (const folder of matched) {
            await recordManualMove(folder, accountId, account.user_id, {
              gmail_message_id: p.gmail_message_id,
              from_addr: p.from_addr,
              subject: p.subject,
              snippet: p.snippet,
            });
          }
        } catch (e) { console.error("labelAdded handler failed", e); }
      }
    }
    if (hist.historyId) await bumpHistoryAndWatch(accountId, hist.historyId);
    return { synced: seenAdded.size };
  } catch (e: any) {
    console.error("history failed, rebootstrapping", e.message);
    await supabaseAdmin.from("gmail_accounts").update({ history_id: null }).eq("id", accountId);
    return { error: e.message };
  }
}
