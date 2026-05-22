// Core sync pipeline: pull messages for a specific gmail_account, apply filters/AI,
// persist, apply Gmail label/actions. Server-only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessage, getMessageMetadata, modifyMessage, parseMessage, listMessages, listHistory, ensureWatch, getMessageLabels, sendMessage, GmailApiError } from "./gmail.server";
import { classifyEmail, classifyEmailsBatch, buildFolderProfile, type ClassifyFolder } from "./ai.server";

type RuleNode =
  | { type: "group"; op: "and" | "or"; children: RuleNode[] }
  | { type: "cond"; field: string; op: string; value: string };

type Folder = {
  id: string;
  name: string;
  gmail_label_id: string | null;
  ai_rule: string | null;
  learned_profile: string | null;
  last_learned_at: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  auto_star: boolean;
  hide_from_inbox: boolean;
  skip_ai: boolean;
  priority: number;
  gmail_account_id: string;
  filter_logic: "any" | "all";
  filter_tree: RuleNode | null;
  forward_to: string | null;
  min_ai_confidence: number;
  snooze_hours: number;
};

type Filter = { id: string; folder_id: string; field: string; op: string; value: string };

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
  email: { from_addr: string; from_name: string; to_addrs: string; cc?: string; list_id?: string; in_reply_to?: string; subject: string; body_text: string; has_attachment: boolean },
  f: Filter
): boolean {
  const v = f.value.toLowerCase();
  const fieldVal = (() => {
    switch (f.field) {
      case "from": return `${email.from_addr} ${email.from_name}`.toLowerCase();
      case "to": return (email.to_addrs || "").toLowerCase();
      case "cc": return (email.cc || "").toLowerCase();
      case "list_id": return (email.list_id || "").toLowerCase();
      case "is_reply": return (email.in_reply_to ? "true" : "false");
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
    case "not_contains": return !fieldVal.includes(v);
    case "not_equals": return fieldVal !== v;
    case "regex":
      try { return new RegExp(f.value, "i").test(fieldVal); } catch { return false; }
    default: return false;
  }
}

const EXCLUDE_OPS = new Set(["not_contains", "not_equals"]);

function evalNode(
  email: Parameters<typeof applyFilter>[0],
  node: RuleNode,
): boolean {
  if (node.type === "cond") {
    return applyFilter(email, { id: "", folder_id: "", field: node.field, op: node.op, value: node.value });
  }
  if (node.op === "and") return node.children.every((c) => evalNode(email, c));
  return node.children.some((c) => evalNode(email, c));
}

function countConds(node: RuleNode): number {
  return node.type === "cond" ? 1 : node.children.reduce((n, c) => n + countConds(c), 0);
}

type FolderMatch =
  | { kind: "match"; folder_id: string; filter: Filter | null; matched_filters: Filter[]; all_matched_folder_ids: string[]; tree_used: boolean }
  | { kind: "excluded"; folder_id: string; folder_name: string; exclude: Filter };

function matchByFilters(
  email: Parameters<typeof applyFilter>[0],
  folders: Folder[],
  filters: Filter[],
): FolderMatch | null {
  const byFolder = new Map<string, Filter[]>();
  for (const f of filters) {
    if (!byFolder.has(f.folder_id)) byFolder.set(f.folder_id, []);
    byFolder.get(f.folder_id)!.push(f);
  }
  const matched: Array<{ folder: Folder; filter: Filter | null; allMatches: Filter[]; treeUsed: boolean }> = [];
  const excludedFolders: Array<{ folder: Folder; exclude: Filter }> = [];
  for (const folder of folders) {
    const fs = byFolder.get(folder.id) || [];
    const excludes = fs.filter((f) => EXCLUDE_OPS.has(f.op));
    const includes = fs.filter((f) => !EXCLUDE_OPS.has(f.op));

    // Tree takes precedence when present and non-empty.
    const tree = folder.filter_tree;
    const hasTree = !!tree && (tree.type === "cond" || (tree.type === "group" && countConds(tree) > 0));

    let passes = false;
    let includeHits: Filter[] = [];
    if (hasTree) {
      passes = evalNode(email, tree!);
    } else {
      if (includes.length === 0) continue;
      includeHits = includes.filter((f) => applyFilter(email, f));
      const logic = folder.filter_logic === "all" ? "all" : "any";
      passes = logic === "all" ? includeHits.length === includes.length : includeHits.length > 0;
    }
    if (!passes) continue;

    const excludeHit = excludes.find((f) => applyFilter(email, f));
    if (excludeHit) {
      excludedFolders.push({ folder, exclude: excludeHit });
      continue;
    }
    matched.push({
      folder,
      filter: hasTree ? null : (includeHits[0] ?? null),
      allMatches: hasTree ? [] : includeHits,
      treeUsed: hasTree,
    });
  }
  if (matched.length > 0) {
    // Sort: highest priority first, then folder name asc for stable tiebreak.
    matched.sort((a, b) =>
      b.folder.priority - a.folder.priority || a.folder.name.localeCompare(b.folder.name)
    );
    return {
      kind: "match",
      folder_id: matched[0].folder.id,
      filter: matched[0].filter,
      matched_filters: matched[0].allMatches,
      all_matched_folder_ids: matched.map((m) => m.folder.id),
      tree_used: matched[0].treeUsed,
    };
  }
  if (excludedFolders.length > 0) {
    excludedFolders.sort((a, b) =>
      b.folder.priority - a.folder.priority || a.folder.name.localeCompare(b.folder.name)
    );
    return {
      kind: "excluded",
      folder_id: excludedFolders[0].folder.id,
      folder_name: excludedFolders[0].folder.name,
      exclude: excludedFolders[0].exclude,
    };
  }
  return null;
}
function labelOf(folders: Folder[], id: string) {
  return folders.find((f) => f.id === id)?.name ?? "folder";
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

export type ClassificationResult = {
  folder_id: string | null;
  classified_by: string;
  ai_confidence: number;
  ai_summary: string;
  classification_reason: string | null;
  matched_filter_ids: string[];
  matched_folder_ids: string[];
};

/**
 * Per-account context shared across a batch of jobs so we don't re-fetch
 * folders / filters / overrides / examples for every single message. Build
 * once at the top of a worker invocation with `loadAccountContext`.
 */
export type AccountContext = {
  folders: Folder[];
  filters: Filter[];
  overrides: Array<{ match_type: string; value: string }>;
  enrichedFolders: ClassifyFolder[];
};

const accountContextCache = new Map<string, { ctx: AccountContext; expires: number }>();
const ACCOUNT_CONTEXT_TTL_MS = 30_000;

export async function loadAccountContext(accountId: string, userId: string): Promise<AccountContext> {
  const cached = accountContextCache.get(accountId);
  if (cached && cached.expires > Date.now()) return cached.ctx;

  const [{ data: folders }, { data: filters }, { data: overrides }] = await Promise.all([
    supabaseAdmin
      .from("folders")
      .select("*")
      .eq("gmail_account_id", accountId)
      .order("priority", { ascending: false }),
    supabaseAdmin.from("folder_filters").select("id, folder_id, field, op, value"),
    supabaseAdmin.from("inbox_overrides").select("match_type, value").eq("user_id", userId),
  ]);

  const folderList = (folders ?? []) as Folder[];
  const folderIds = new Set(folderList.map((f) => f.id));
  const filterList = ((filters ?? []) as Filter[]).filter((f) => folderIds.has(f.folder_id));
  const enrichedFolders = await loadFoldersWithExamples(folderList);

  const ctx: AccountContext = {
    folders: folderList,
    filters: filterList,
    overrides: overrides ?? [],
    enrichedFolders,
  };
  accountContextCache.set(accountId, { ctx, expires: Date.now() + ACCOUNT_CONTEXT_TTL_MS });
  return ctx;
}

export async function classifyParsedEmail(
  parsed: {
    from_addr: string;
    from_name: string;
    to_addrs: string;
    cc?: string;
    list_id?: string;
    in_reply_to?: string;
    subject: string;
    snippet: string;
    body_text: string;
    body_html: string;
    has_attachment: boolean;
    received_at: string;
    raw_labels: string[] | null;
  },
  userId: string,
  accountId: string,
  opts: { skipGmailLabelMatch?: boolean; context?: AccountContext; skipAi?: boolean } = {},
): Promise<ClassificationResult> {
  const context = opts.context ?? (await loadAccountContext(accountId, userId));
  const folderList = context.folders;
  const filterList = context.filters;
  const overrides = context.overrides;

  let folder_id: string | null = null;
  let classified_by = "none";
  let confidence = 0;
  let summary = "";
  let classification_reason: string | null = null;
  let matched_filter_ids: string[] = [];
  let matched_folder_ids: string[] = [];
  let aiSkipped = false;

  const fromAddr = (parsed.from_addr || "").toLowerCase();
  const fromDomain = fromAddr.split("@")[1] || "";
  const overrideHit = overrides.find((o) => {
    const val = (o.value || "").toLowerCase();
    return o.match_type === "email" ? val === fromAddr : val === fromDomain;
  });

  if (overrideHit) {
    classified_by = "global_exclude";
    classification_reason = `Global inbox list: ${overrideHit.match_type} "${overrideHit.value}"`;
    aiSkipped = true;
  } else {
    const labeledFolder = opts.skipGmailLabelMatch
      ? undefined
      : folderList.find((f) => f.gmail_label_id && parsed.raw_labels?.includes(f.gmail_label_id));
    if (labeledFolder) {
      folder_id = labeledFolder.id;
      classified_by = "gmail_label";
      confidence = 1;
      classification_reason = `Already labeled "${labeledFolder.name}" in Gmail at sync time`;
    } else {
      const m = matchByFilters(parsed, folderList, filterList);
      if (m?.kind === "match") {
        folder_id = m.folder_id;
        matched_folder_ids = m.all_matched_folder_ids;
        confidence = 1;
        if (m.tree_used) {
          classified_by = "filter";
          classification_reason = `Rule group matched for "${labelOf(folderList, m.folder_id)}"`;
        } else if (m.filter) {
          classified_by = m.filter.field === "domain" ? "domain_rule" : "filter";
          matched_filter_ids = m.matched_filters.map((f) => f.id);
          classification_reason =
            classified_by === "domain_rule"
              ? `Domain rule: ${m.filter.value} → ${labelOf(folderList, m.folder_id)}`
              : `Filter: ${m.filter.field} ${m.filter.op} "${m.filter.value}"`;
        }
      } else if (m?.kind === "excluded") {
        classified_by = "excluded";
        classification_reason = `Would match "${m.folder_name}" but excluded by rule: ${m.exclude.field} ${m.exclude.op} "${m.exclude.value}"`;
        aiSkipped = true;
      }
    }
  }

  if (!folder_id && !aiSkipped && !opts.skipAi && folderList.length > 0) {
    // Exclude folders flagged skip_ai from the AI candidate set.
    const skipAiIds = new Set(folderList.filter((f) => f.skip_ai).map((f) => f.id));
    const aiFolders = context.enrichedFolders.filter((f) => !skipAiIds.has(f.id));
    if (aiFolders.length > 0) {
      try {
        const r = await classifyEmail(parsed, aiFolders);
        const candidate = folderList.find((f) => f.id === r.folder_id);
        const threshold = candidate?.min_ai_confidence ?? 0;
        if (r.folder_id && r.confidence >= threshold) {
          folder_id = r.folder_id;
          confidence = r.confidence;
          summary = r.summary;
          classified_by = "ai";
          classification_reason = r.reason || null;
        } else if (r.folder_id) {
          classified_by = "ai_low_confidence";
          confidence = r.confidence;
          summary = r.summary;
          classification_reason = `AI suggested "${candidate?.name ?? "?"}" at ${(r.confidence * 100).toFixed(0)}% < min ${(threshold * 100).toFixed(0)}%`;
        } else {
          classified_by = "ai";
          confidence = r.confidence;
          summary = r.summary;
          classification_reason = r.reason || null;
        }
      } catch (e) {
        console.error("AI classify failed", e);
        classified_by = "ai_error";
        classification_reason = `AI classifier failed: ${(e as Error)?.message ?? "unknown error"}`;
      }
    }
  }

  return {
    folder_id,
    classified_by,
    ai_confidence: confidence,
    ai_summary: summary,
    classification_reason,
    matched_filter_ids,
    matched_folder_ids,
  };
}

export async function processGmailMessage(
  accountId: string,
  gmailId: string,
  userId: string,
  opts: { context?: AccountContext; skipAi?: boolean } = {},
) {

  const { data: existing } = await supabaseAdmin
    .from("emails")
    .select("id, from_addr, subject, body_text, body_html, received_at")
    .eq("gmail_message_id", gmailId)
    .eq("gmail_account_id", accountId)
    .maybeSingle();

  const raw = await getMessage(accountId, gmailId);
  const parsed = parseMessage(raw);

  if (existing) {
    // Repair rows that were inserted with missing/blank metadata.
    const needsRepair =
      !existing.from_addr ||
      !existing.subject ||
      (!existing.body_text && !existing.body_html) ||
      !existing.received_at;
    if (needsRepair) {
      await supabaseAdmin.from("emails").update({
        from_addr: parsed.from_addr,
        from_name: parsed.from_name,
        to_addrs: parsed.to_addrs,
        subject: parsed.subject,
        snippet: parsed.snippet,
        body_text: parsed.body_text,
        body_html: parsed.body_html,
        received_at: parsed.received_at,
        has_attachment: parsed.has_attachment,
        raw_labels: parsed.raw_labels,
        is_read: parsed.is_read,
      }).eq("id", existing.id);
      return { repaired: true };
    }
    return { skipped: true };
  }

  const labels = parsed.raw_labels ?? [];
  const EXCLUDED_LABELS = ["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"];
  if (EXCLUDED_LABELS.some((l) => labels.includes(l))) return { skipped: true };
  const inInbox = labels.includes("INBOX");

  // 1) Insert the email row FIRST with no folder so it shows up in Inbox
  //    immediately, even if classification (AI Gateway) is slow or fails.
  //    Classification runs in step 2 and UPDATEs the row.
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
      cc: parsed.cc || null,
      list_id: parsed.list_id || null,
      in_reply_to: parsed.in_reply_to || null,
      subject: parsed.subject,
      snippet: parsed.snippet,
      body_text: parsed.body_text,
      body_html: parsed.body_html,
      received_at: parsed.received_at,
      is_read: parsed.is_read,
      has_attachment: parsed.has_attachment,
      raw_labels: parsed.raw_labels,
      folder_id: null,
      is_archived: !inInbox,
      classified_by: "pending",
      processed_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    console.error("insert email failed", error);
    return { error: error.message };
  }

  // 2) Classify. If this throws or times out, the email is already in Inbox.
  let folder_id: string | null = null;
  try {
    const c = await classifyParsedEmail(parsed, userId, accountId, {
      context: opts.context,
      skipAi: opts.skipAi,
    });
    folder_id = c.folder_id ?? null;
    await supabaseAdmin.from("emails").update({
      folder_id,
      ai_summary: c.ai_summary || null,
      ai_confidence: c.ai_confidence,
      classified_by: c.classified_by,
      classification_reason: c.classification_reason,
      matched_filter_ids: c.matched_filter_ids,
      matched_folder_ids: c.matched_folder_ids,
    }).eq("id", inserted.id);
  } catch (e) {
    console.error("classify failed (email already visible in Inbox)", e);
    await supabaseAdmin.from("emails").update({
      classified_by: "unclassified",
      classification_reason: `Classification failed: ${(e as Error)?.message?.slice(0, 200) ?? "unknown"}`,
    }).eq("id", inserted.id);
    return { id: inserted.id, classify_failed: true };
  }

  // 3) Apply Gmail label / auto-archive / auto-mark-read for the assigned folder.
  //    Use the prefetched folder list when available to avoid an extra round trip.
  if (folder_id) {
    let folder: {
      id: string; gmail_label_id: string | null; auto_archive: boolean;
      auto_mark_read: boolean; auto_star: boolean; hide_from_inbox: boolean;
      forward_to: string | null; snooze_hours: number;
    } | null = null;
    const cached = opts.context?.folders.find((f) => f.id === folder_id);
    if (cached) {
      folder = {
        id: cached.id,
        gmail_label_id: cached.gmail_label_id,
        auto_archive: cached.auto_archive,
        auto_mark_read: cached.auto_mark_read,
        auto_star: cached.auto_star,
        hide_from_inbox: cached.hide_from_inbox,
        forward_to: cached.forward_to,
        snooze_hours: cached.snooze_hours,
      };
    } else {
      const { data } = await supabaseAdmin
        .from("folders")
        .select("id, gmail_label_id, auto_archive, auto_mark_read, auto_star, hide_from_inbox, forward_to, snooze_hours")
        .eq("id", folder_id)
        .maybeSingle();
      folder = data ?? null;
    }
    if (folder) {
      // hide_from_inbox behaves like auto_archive for the inbox view.
      const effectiveArchive = folder.auto_archive || folder.hide_from_inbox;
      const addLabels: string[] = [];
      const removeLabels: string[] = [];
      if (folder.gmail_label_id && !parsed.raw_labels?.includes(folder.gmail_label_id)) addLabels.push(folder.gmail_label_id);
      if (folder.auto_mark_read) removeLabels.push("UNREAD");
      if (folder.auto_star && !parsed.raw_labels?.includes("STARRED")) addLabels.push("STARRED");
      if (inInbox && effectiveArchive) removeLabels.push("INBOX");
      if (addLabels.length || removeLabels.length) {
        try { await modifyMessage(accountId, gmailId, addLabels, removeLabels); } catch (e) { console.error("modify failed", e); }
      }
      const patch: {
        is_archived?: boolean;
        is_read?: boolean;
        snoozed_until?: string;
        forwarded_to?: string;
        forwarded_at?: string;
      } = {};
      if (inInbox && effectiveArchive) patch.is_archived = true;
      if (folder.auto_mark_read) patch.is_read = true;
      if (folder.snooze_hours && folder.snooze_hours > 0) {
        patch.snoozed_until = new Date(Date.now() + folder.snooze_hours * 3600_000).toISOString();
      }
      if (folder.forward_to) {
        try {
          await sendMessage(
            accountId,
            folder.forward_to,
            `Fwd: ${parsed.subject || "(no subject)"}`,
            `---------- Forwarded message ----------\nFrom: ${parsed.from_name || ""} <${parsed.from_addr}>\nDate: ${parsed.received_at}\nSubject: ${parsed.subject}\n\n${parsed.body_text || parsed.snippet || ""}`,
          );
          patch.forwarded_to = folder.forward_to;
          patch.forwarded_at = new Date().toISOString();
        } catch (e) {
          console.error("auto-forward failed", e);
        }
      }
      if (Object.keys(patch).length > 0) {
        await supabaseAdmin.from("emails").update(patch).eq("id", inserted.id);
      }
    }
  }


  return { id: inserted.id, email_id: inserted.id, folder_id, parsed };
}

async function recordManualMove(
  folder: Folder,
  accountId: string,
  userId: string,
  msg: { gmail_message_id: string; from_addr: string; subject: string; snippet: string }
) {
  // Skip when this labelsAdded event is just Gmail echoing a label we applied
  // ourselves during AI/filter/label classification.
  const { data: existingRow } = await supabaseAdmin
    .from("emails")
    .select("folder_id, classified_by")
    .eq("gmail_message_id", msg.gmail_message_id)
    .eq("gmail_account_id", accountId)
    .maybeSingle();
  if (
    existingRow &&
    existingRow.folder_id === folder.id &&
    ["ai", "filter", "gmail_label", "domain_rule", "manual_move"].includes(
      existingRow.classified_by ?? ""
    )
  ) {
    return;
  }

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
    .update({
      folder_id: folder.id,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: `Moved to "${folder.name}" manually in Gmail`,
    })
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
  const { data: folderRow } = await supabaseAdmin.from("folders").select("*").eq("id", folderId).single();
  if (!folderRow) throw new Error("Folder not found");
  const folder = folderRow;
  if (folder.user_id !== userId) throw new Error("Not authorized");
  if (!folder.gmail_label_id) throw new Error("Folder is not linked to a Gmail label");
  const accountId = folder.gmail_account_id;

  // Cap the on-click learn at 200 (profile uses latest 50; 200 gives headroom).
  const MAX_MESSAGES = 200;

  // Source A: Gmail messages currently bearing the linked label.
  const list = await listMessages(accountId, {
    maxResults: MAX_MESSAGES,
    labelIds: [folder.gmail_label_id],
  });
  const gmailIds = (list.messages ?? []).map((m) => m.id).slice(0, MAX_MESSAGES);

  // Source B: local emails already routed to this folder by rules / manual move.
  // We already have from_addr/subject/snippet here — no Gmail fetch needed.
  const { data: localRows } = await supabaseAdmin
    .from("emails")
    .select("gmail_message_id, from_addr, subject, snippet")
    .eq("folder_id", folderId)
    .order("received_at", { ascending: false })
    .limit(MAX_MESSAGES);

  // Skip ids we already have as examples for this folder.
  const candidateIds = Array.from(new Set([...gmailIds, ...(localRows ?? []).map((r) => r.gmail_message_id)]));
  let knownSet = new Set<string>();
  if (candidateIds.length > 0) {
    const { data: known } = await supabaseAdmin
      .from("folder_examples")
      .select("gmail_message_id")
      .eq("folder_id", folderId)
      .in("gmail_message_id", candidateIds);
    knownSet = new Set((known ?? []).map((r) => r.gmail_message_id));
  }

  let learned = 0;
  let ingested = 0;
  let claimed = 0;

  // Seed from local rows first (cheap — no Gmail roundtrip).
  const seededFromLocal = new Set<string>();
  for (const row of localRows ?? []) {
    if (knownSet.has(row.gmail_message_id)) continue;
    const { error } = await supabaseAdmin.from("folder_examples").upsert(
      {
        folder_id: folderId,
        gmail_account_id: accountId,
        user_id: userId,
        gmail_message_id: row.gmail_message_id,
        from_addr: row.from_addr,
        subject: row.subject,
        snippet: row.snippet,
        source: "seed",
      },
      { onConflict: "folder_id,gmail_message_id" },
    );
    if (!error) {
      learned++;
      seededFromLocal.add(row.gmail_message_id);
    }
  }

  // Fetch from Gmail only for label-only ids we haven't already seeded.
  const idsToFetch = gmailIds.filter((id) => !knownSet.has(id) && !seededFromLocal.has(id));

  // Parallel pool of 10 — biggest wall-clock win.
  const CONCURRENCY = 10;
  async function processOne(id: string) {
    try {
      const raw = await getMessageMetadata(accountId, id);
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

      // Tag local email if present; insert a lightweight row otherwise.
      // We skip body_text/body_html — normal sync fills those in later.
      const { data: existing } = await supabaseAdmin
        .from("emails")
        .select("id, folder_id")
        .eq("gmail_message_id", p.gmail_message_id)
        .maybeSingle();
      if (existing) {
        if (existing.folder_id !== folderId) {
          await supabaseAdmin
            .from("emails")
            .update({
              folder_id: folderId,
              classified_by: "gmail_label",
              ai_confidence: 1,
              classification_reason: `Matched Gmail label "${folder.name}"`,
            })
            .eq("id", existing.id);
          claimed++;
        }
      } else {
        const { error: insErr } = await supabaseAdmin.from("emails").insert({
          user_id: userId,
          gmail_account_id: accountId,
          gmail_message_id: p.gmail_message_id,
          thread_id: p.thread_id,
          from_addr: p.from_addr,
          from_name: p.from_name,
          to_addrs: p.to_addrs,
          subject: p.subject,
          snippet: p.snippet,
          received_at: p.received_at,
          is_read: p.is_read,
          is_archived: !p.raw_labels?.includes("INBOX"),
          has_attachment: p.has_attachment,
          raw_labels: p.raw_labels,
          folder_id: folderId,
          classified_by: "gmail_label",
          ai_confidence: 1,
          classification_reason: `Matched Gmail label "${folder.name}"`,
        });
        if (!insErr) ingested++;
        else console.error("ingest labeled message failed", insErr);
      }
    } catch (e) {
      console.error("seed example failed", e);
    }
  }

  for (let i = 0; i < idsToFetch.length; i += CONCURRENCY) {
    const chunk = idsToFetch.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(processOne));
  }

  const profile = await regenerateFolderProfile(folderId);
  return { learned, ingested, claimed, profile };
}

export async function backfillRecent(accountId: string, userId: string, maxResults = 30) {
  // Include mail that filters auto-route past the inbox (e.g. Cold Email).
  const list = await listMessages(accountId, { maxResults, q: "-in:chats -in:trash -in:spam newer_than:7d" });
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

export async function backfillWindow(
  accountId: string,
  userId: string,
  opts: { query: string; maxMessages?: number; concurrency?: number },
) {
  const started = Date.now();
  const maxMessages = opts.maxMessages ?? 1000;
  const concurrency = opts.concurrency ?? 4;

  // 1) Page through Gmail collecting IDs, de-duped.
  const ids: string[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;
  while (ids.length < maxMessages) {
    const remaining = maxMessages - ids.length;
    const list = await listMessages(accountId, {
      q: opts.query,
      maxResults: Math.min(100, remaining),
      pageToken,
    });
    for (const m of list.messages ?? []) {
      if (!seen.has(m.id)) { seen.add(m.id); ids.push(m.id); }
      if (ids.length >= maxMessages) break;
    }
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  // 2) Drop IDs we already have for this account (batched).
  let alreadyHad = 0;
  const todo: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { data: existing } = await supabaseAdmin
      .from("emails")
      .select("gmail_message_id")
      .eq("gmail_account_id", accountId)
      .in("gmail_message_id", slice);
    const have = new Set((existing ?? []).map((r) => r.gmail_message_id));
    for (const id of slice) {
      if (have.has(id)) alreadyHad++;
      else todo.push(id);
    }
  }

  // 3) Process with bounded concurrency.
  let processed = 0;
  let failed = 0;
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) return;
      try {
        await processGmailMessage(accountId, todo[i], userId);
        processed++;
      } catch (e) {
        failed++;
        console.error("backfillWindow process failed", todo[i], e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  return {
    found: ids.length,
    alreadyHad,
    processed,
    failed,
    durationMs: Date.now() - started,
  };
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

// ─── Deep backfill jobs (background, paginated across cron ticks) ─────────

type BackfillJob = {
  id: string;
  user_id: string;
  gmail_account_id: string;
  query: string;
  status: string;
  next_page_token: string | null;
  total_found: number;
  total_enqueued: number;
  already_had: number;
};

const BACKFILL_LIST_PAGES_PER_TICK = 20; // ~2000 IDs per tick
const BACKFILL_PAGE_SIZE = 100;

export async function startBackfillJob(
  accountId: string,
  userId: string,
  opts: { months: number },
): Promise<{ job_id: string; reused: boolean }> {
  const months = Math.min(Math.max(opts.months, 1), 120);

  // Reuse any active job for this account.
  const { data: existing } = await supabaseAdmin
    .from("backfill_jobs")
    .select("id")
    .eq("gmail_account_id", accountId)
    .in("status", ["listing", "processing"])
    .limit(1)
    .maybeSingle();
  if (existing) return { job_id: existing.id, reused: true };

  // Use a date anchor so the query is stable across ticks (newer_than:Nd
  // would shift as time passes). Gmail "after:" accepts YYYY/MM/DD.
  const since = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
  const y = since.getUTCFullYear();
  const m = String(since.getUTCMonth() + 1).padStart(2, "0");
  const d = String(since.getUTCDate()).padStart(2, "0");
  const query = `after:${y}/${m}/${d} -in:chats -in:trash -in:spam`;

  const { data: row, error } = await supabaseAdmin
    .from("backfill_jobs")
    .insert({
      user_id: userId,
      gmail_account_id: accountId,
      query,
      months,
      status: "listing",
    })
    .select("id")
    .single();
  if (error || !row) throw new Error(`Failed to start backfill: ${error?.message}`);
  return { job_id: row.id, reused: false };
}

export async function cancelBackfillJob(jobId: string, userId: string) {
  await supabaseAdmin
    .from("backfill_jobs")
    .update({ status: "canceled", finished_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("user_id", userId)
    .in("status", ["listing", "processing"]);
  return { ok: true };
}

export async function tickBackfillJobs(maxJobs = 2) {
  const { data: jobs } = await supabaseAdmin
    .from("backfill_jobs")
    .select("id, user_id, gmail_account_id, query, status, next_page_token, total_found, total_enqueued, already_had")
    .in("status", ["listing", "processing"])
    .order("updated_at", { ascending: true })
    .limit(maxJobs);
  const results: Array<{ job_id: string; phase: string; added?: number; error?: string }> = [];
  for (const job of (jobs ?? []) as BackfillJob[]) {
    try {
      const r = await tickBackfillJob(job);
      results.push({ job_id: job.id, ...r });
    } catch (e: any) {
      console.error("tickBackfillJob failed", job.id, e);
      await supabaseAdmin
        .from("backfill_jobs")
        .update({ last_error: String(e?.message ?? e).slice(0, 500) })
        .eq("id", job.id);
      results.push({ job_id: job.id, phase: "error", error: String(e?.message ?? e) });
    }
  }
  return { processed: results.length, results };
}

async function tickBackfillJob(job: BackfillJob): Promise<{ phase: string; added?: number }> {
  if (job.status === "listing") {
    let pageToken: string | undefined = job.next_page_token ?? undefined;
    let foundDelta = 0;
    let enqueuedDelta = 0;
    let alreadyDelta = 0;
    let pages = 0;

    while (pages < BACKFILL_LIST_PAGES_PER_TICK) {
      const list = await listMessages(job.gmail_account_id, {
        q: job.query,
        maxResults: BACKFILL_PAGE_SIZE,
        pageToken,
      });
      const ids = (list.messages ?? []).map((m) => m.id);
      foundDelta += ids.length;
      pages++;

      if (ids.length > 0) {
        // Dedupe vs already-stored emails for this account.
        const { data: existing } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("gmail_account_id", job.gmail_account_id)
          .in("gmail_message_id", ids);
        const have = new Set((existing ?? []).map((r) => r.gmail_message_id));
        const todo = ids.filter((id) => !have.has(id));
        alreadyDelta += ids.length - todo.length;

        for (const id of todo) {
          try {
            await enqueueMessageJob(job.gmail_account_id, job.user_id, id, 10);
            enqueuedDelta++;
          } catch (e) {
            console.error("backfill enqueue failed", id, e);
          }
        }
      }

      pageToken = list.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    const done = !pageToken;
    await supabaseAdmin
      .from("backfill_jobs")
      .update({
        next_page_token: pageToken ?? null,
        total_found: job.total_found + foundDelta,
        total_enqueued: job.total_enqueued + enqueuedDelta,
        already_had: job.already_had + alreadyDelta,
        status: done ? "processing" : "listing",
      })
      .eq("id", job.id);

    return { phase: done ? "listed" : "listing", added: enqueuedDelta };
  }

  // processing: drain wait — check remaining message_jobs for this account.
  const { count } = await supabaseAdmin
    .from("message_jobs")
    .select("id", { count: "exact", head: true })
    .eq("gmail_account_id", job.gmail_account_id)
    .neq("status", "dlq");

  if ((count ?? 0) === 0) {
    await supabaseAdmin
      .from("backfill_jobs")
      .update({ status: "done", finished_at: new Date().toISOString() })
      .eq("id", job.id);
    return { phase: "done" };
  }

  // Touch updated_at so the picker rotates fairly.
  await supabaseAdmin
    .from("backfill_jobs")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", job.id);
  return { phase: "draining" };
}



async function applyLabelChange(
  accountId: string,
  messageId: string,
  currentLabels: string[] | undefined,
  added: string[],
  removed: string[],
) {
  const patch: { raw_labels?: string[]; is_archived?: boolean; is_read?: boolean } = {};
  if (currentLabels) patch.raw_labels = currentLabels;
  if (removed.includes("INBOX")) patch.is_archived = true;
  if (added.includes("INBOX")) patch.is_archived = false;
  if (removed.includes("UNREAD")) patch.is_read = true;
  if (added.includes("UNREAD")) patch.is_read = false;
  if (added.includes("TRASH")) {
    await supabaseAdmin.from("emails").delete()
      .eq("gmail_account_id", accountId)
      .eq("gmail_message_id", messageId);
    return;
  }
  if (Object.keys(patch).length === 0) return;
  await supabaseAdmin.from("emails").update(patch)
    .eq("gmail_account_id", accountId)
    .eq("gmail_message_id", messageId);
}


// ─── Durable per-message processing queue ─────────────────────────────────

const MAX_JOB_ATTEMPTS = 5;
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200]; // 30s, 2m, 10m, 30m, 2h
// Short jittered backoff for transient Gmail-side failures (429, 5xx, timeout).
// First 2 retryable failures don't count toward MAX_JOB_ATTEMPTS, so a flaky
// Google API won't burn a message into the DLQ.
const RETRYABLE_BACKOFF_SECONDS = [30, 90, 300, 900, 3600]; // 30s, 1.5m, 5m, 15m, 1h
const RETRYABLE_FREE_ATTEMPTS = 2;

function jitter(seconds: number): number {
  return Math.floor(seconds * (0.75 + Math.random() * 0.5));
}

export async function enqueueMessageJob(
  accountId: string,
  userId: string,
  gmailMessageId: string,
  priority: number = 0,
) {
  // Upsert so the same message is never queued twice. If a job already exists
  // (pending or dlq), do nothing — the worker / retry button owns it from here.
  // priority: 0 = live (push/poll), 10 = backfill. Worker orders by priority ASC
  // so live mail always jumps ahead of the backfill backlog.
  await supabaseAdmin
    .from("message_jobs")
    .upsert(
      {
        gmail_account_id: accountId,
        gmail_message_id: gmailMessageId,
        user_id: userId,
        status: "pending",
        priority,
        next_run_at: new Date().toISOString(),
      },
      { onConflict: "gmail_account_id,gmail_message_id", ignoreDuplicates: true },
    );
}

export async function runMessageJobs(
  limit = 100,
  concurrency = 16,
  opts: { priority?: number } = {},
) {
  const STUCK_MS = 90 * 1000; // jobs in 'running' for >90s are presumed dead (worker timeout)
  const JOB_TIMEOUT_MS = 25 * 1000; // hard timeout for processGmailMessage

  // ─── Self-heal: reclaim any 'running' jobs whose worker died mid-execution.
  const stuckCutoff = new Date(Date.now() - STUCK_MS).toISOString();
  const { data: stuck } = await supabaseAdmin
    .from("message_jobs")
    .select("id, attempt")
    .eq("status", "running")
    .lt("locked_at", stuckCutoff);
  for (const s of stuck ?? []) {
    const nextAttempt = (s.attempt ?? 0) + 1;
    if (nextAttempt >= MAX_JOB_ATTEMPTS) {
      await supabaseAdmin.from("message_jobs").update({
        status: "dlq",
        attempt: nextAttempt,
        last_error: "stuck (worker timeout — exceeded max attempts)",
        locked_at: null,
      }).eq("id", s.id);
    } else {
      const backoff = jitter(BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)]);
      await supabaseAdmin.from("message_jobs").update({
        status: "pending",
        attempt: nextAttempt,
        last_error: "stuck (worker timeout) — auto-reclaimed",
        locked_at: null,
        next_run_at: new Date(Date.now() + backoff * 1000).toISOString(),
      }).eq("id", s.id);
    }
  }

  // ─── Atomic claim: single round-trip, parallel workers can't collide.
  const { data: claimedRows, error: claimErr } = await supabaseAdmin.rpc("claim_message_jobs", {
    p_limit: limit,
    p_priority: opts.priority ?? undefined,
  });
  if (claimErr) {
    console.error("claim_message_jobs RPC failed", claimErr);
    return { processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0, error: claimErr.message };
  }
  type ClaimedJob = {
    id: string;
    gmail_account_id: string;
    gmail_message_id: string;
    user_id: string;
    attempt: number;
    priority: number;
  };
  const claimed = (claimedRows ?? []) as ClaimedJob[];
  if (claimed.length === 0) {
    return { processed: 0, ok: 0, failed: 0, dlq: 0, retryable: 0 };
  }

  // ─── Prefetch per-account context once for the whole batch.
  const accountIds = Array.from(new Set(claimed.map((j) => j.gmail_account_id)));
  const userByAccount = new Map<string, string>();
  for (const j of claimed) if (!userByAccount.has(j.gmail_account_id)) userByAccount.set(j.gmail_account_id, j.user_id);
  const contextByAccount = new Map<string, AccountContext>();
  await Promise.all(
    accountIds.map(async (aid) => {
      try {
        contextByAccount.set(aid, await loadAccountContext(aid, userByAccount.get(aid)!));
      } catch (e) {
        console.error("loadAccountContext failed", aid, e);
      }
    }),
  );

  const results: Array<{ id: string; ok: boolean; error?: string; dlq?: boolean; retryable?: boolean }> = [];

  // After the first per-message pass, backfill messages still needing AI
  // are queued here for a single batched LLM call per account.
  type PendingAi = {
    job: ClaimedJob;
    emailRowId: string;
    parsed: Parameters<typeof classifyParsedEmail>[0];
  };
  const pendingAi: PendingAi[] = [];

  const handleError = async (job: ClaimedJob, e: any) => {
    const msg = e?.message ?? String(e);
    const status: number | undefined = e instanceof GmailApiError ? e.status : undefined;
    const retryable: boolean = e instanceof GmailApiError
      ? e.retryable
      : (typeof msg === "string" && /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(msg));

    if (status === 404 || (typeof msg === "string" && msg.includes(" 404 "))) {
      await supabaseAdmin.from("message_jobs").delete().eq("id", job.id);
      results.push({ id: job.id, ok: true });
      return;
    }

    const terminal = status === 400 || status === 401 || status === 403;
    const currentAttempt = job.attempt ?? 0;
    const nextAttempt = retryable && currentAttempt < RETRYABLE_FREE_ATTEMPTS
      ? currentAttempt
      : currentAttempt + 1;

    if (terminal || nextAttempt >= MAX_JOB_ATTEMPTS) {
      let from_addr: string | null = null;
      let subject: string | null = null;
      try {
        const meta = await getMessageMetadata(job.gmail_account_id, job.gmail_message_id);
        const p = parseMessage(meta);
        from_addr = p.from_addr ?? null;
        subject = p.subject ?? null;
      } catch { /* best-effort */ }
      await supabaseAdmin.from("message_jobs").update({
        status: "dlq",
        attempt: nextAttempt,
        last_error: msg.slice(0, 1000),
        locked_at: null,
        from_addr,
        subject,
      }).eq("id", job.id);
      results.push({ id: job.id, ok: false, dlq: true, error: msg });
    } else {
      const table = retryable ? RETRYABLE_BACKOFF_SECONDS : BACKOFF_SECONDS;
      const idx = retryable ? Math.min(currentAttempt, table.length - 1) : Math.min(nextAttempt - 1, table.length - 1);
      const backoff = jitter(table[idx]);
      await supabaseAdmin.from("message_jobs").update({
        status: "pending",
        attempt: nextAttempt,
        last_error: msg.slice(0, 1000),
        locked_at: null,
        next_run_at: new Date(Date.now() + backoff * 1000).toISOString(),
      }).eq("id", job.id);
      results.push({ id: job.id, ok: false, retryable, error: msg });
    }

    if (retryable && status && status !== 0) {
      try {
        await supabaseAdmin.from("pubsub_events").insert({
          event_type: "gmail_api_error",
          history_id: null,
          error: `Gmail API ${status}: ${msg.slice(0, 300)}`,
        });
      } catch { /* best-effort */ }
    }
  };

  const processOne = async (job: ClaimedJob) => {
    const ctx = contextByAccount.get(job.gmail_account_id);
    // For backfill jobs (priority>=10) defer AI to the batched pass below.
    const deferAi = job.priority >= 10;
    try {
      const result = (await Promise.race([
        processGmailMessage(job.gmail_account_id, job.gmail_message_id, job.user_id, {
          context: ctx,
          skipAi: deferAi,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`job timeout after ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS),
        ),
      ])) as Awaited<ReturnType<typeof processGmailMessage>>;

      // Queue for batched AI if this backfill row landed in Inbox (no folder yet)
      // and AI was deferred. We use classified_by check via the parsed result.
      if (
        deferAi &&
        result &&
        "email_id" in result &&
        result.email_id &&
        !result.folder_id &&
        result.parsed &&
        ctx &&
        ctx.folders.length > 0
      ) {
        pendingAi.push({ job, emailRowId: result.email_id, parsed: result.parsed });
        // Don't delete the job row yet — finalize after batch AI completes.
        return;
      }

      await supabaseAdmin.from("message_jobs").delete().eq("id", job.id);
      results.push({ id: job.id, ok: true });
    } catch (e: any) {
      await handleError(job, e);
    }
  };

  // ─── Pool of N workers draining the claimed queue.
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      await processOne(job);
    }
  });
  await Promise.all(workers);

  // ─── Second pass: batched AI classification for backfill messages.
  // Group by account, chunk into batches of 8 emails per Gemini call.
  const BATCH_SIZE = 8;
  if (pendingAi.length > 0) {
    const byAccount = new Map<string, PendingAi[]>();
    for (const p of pendingAi) {
      if (!byAccount.has(p.job.gmail_account_id)) byAccount.set(p.job.gmail_account_id, []);
      byAccount.get(p.job.gmail_account_id)!.push(p);
    }
    await Promise.all(
      Array.from(byAccount.entries()).map(async ([aid, items]) => {
        const ctx = contextByAccount.get(aid);
        if (!ctx) return;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const chunk = items.slice(i, i + BATCH_SIZE);
          try {
            const out = await classifyEmailsBatch(chunk.map((c) => c.parsed), ctx.enrichedFolders);
            await Promise.all(
              chunk.map(async (c, idx) => {
                const r = out[idx];
                await supabaseAdmin.from("emails").update({
                  folder_id: r?.folder_id ?? null,
                  ai_summary: r?.summary || null,
                  ai_confidence: r?.confidence ?? 0,
                  classified_by: r?.folder_id ? "ai" : "ai",
                  classification_reason: r?.reason || null,
                }).eq("id", c.emailRowId);
                await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
                results.push({ id: c.job.id, ok: true });
              }),
            );
          } catch (e: any) {
            // Batch failed — fall back to per-message classify so the queue still drains.
            console.error("batch AI classify failed, falling back per-message", e?.message ?? e);
            await Promise.all(
              chunk.map(async (c) => {
                try {
                  const single = await classifyEmail(c.parsed, ctx.enrichedFolders);
                  await supabaseAdmin.from("emails").update({
                    folder_id: single.folder_id,
                    ai_summary: single.summary || null,
                    ai_confidence: single.confidence,
                    classified_by: "ai",
                    classification_reason: single.reason || null,
                  }).eq("id", c.emailRowId);
                  await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
                  results.push({ id: c.job.id, ok: true });
                } catch (innerErr: any) {
                  await supabaseAdmin.from("emails").update({
                    classified_by: "unclassified",
                    classification_reason: `AI classifier failed: ${(innerErr?.message ?? "unknown").slice(0, 200)}`,
                  }).eq("id", c.emailRowId);
                  await supabaseAdmin.from("message_jobs").delete().eq("id", c.job.id);
                  results.push({ id: c.job.id, ok: true });
                }
              }),
            );
          }
        }
      }),
    );
  }

  return {
    processed: results.length,
    ok: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok && !r.dlq).length,
    dlq: results.filter(r => r.dlq).length,
    retryable: results.filter(r => r.retryable).length,
  };
}


export async function retryMessageJob(jobId: string) {
  await supabaseAdmin.from("message_jobs").update({
    status: "pending",
    attempt: 0,
    locked_at: null,
    next_run_at: new Date().toISOString(),
  }).eq("id", jobId);
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
        try { await enqueueMessageJob(accountId, account.user_id, m.id); } catch (e) { console.error("enqueue failed", e); }
      }
      for (const ev of h.labelsAdded ?? []) {
        try { await applyLabelChange(accountId, ev.message.id, ev.message.labelIds, ev.labelIds, []); } catch (e) { console.error("applyLabelChange add failed", e); }
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
      for (const ev of h.labelsRemoved ?? []) {
        try { await applyLabelChange(accountId, ev.message.id, ev.message.labelIds, [], ev.labelIds); } catch (e) { console.error("applyLabelChange remove failed", e); }
      }
      for (const ev of h.messagesDeleted ?? []) {
        try {
          await supabaseAdmin.from("emails").delete()
            .eq("gmail_account_id", accountId)
            .eq("gmail_message_id", ev.message.id);
        } catch (e) { console.error("messagesDeleted handler failed", e); }
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

/**
 * Safety net: reconcile rows the app still considers "in inbox" against Gmail's
 * actual current labels. Catches messages whose history events we missed.
 */
export async function reconcileLocalInbox(accountId: string, limit = 100) {
  const { data: rows } = await supabaseAdmin
    .from("emails")
    .select("id, gmail_message_id, raw_labels, from_addr, subject, body_text, body_html, received_at, folder_id")
    .eq("gmail_account_id", accountId)
    .eq("is_archived", false)
    .order("received_at", { ascending: false, nullsFirst: true })
    .limit(limit);


  let archived = 0;
  let deleted = 0;
  let updated = 0;
  let repaired = 0;
  let failed = 0;

  for (const row of rows ?? []) {
    try {
      const needsRepair =
        !row.from_addr ||
        !row.subject ||
        (!row.body_text && !row.body_html) ||
        !row.received_at;

      if (needsRepair) {
        try {
          const raw = await getMessage(accountId, row.gmail_message_id);
          const parsed = parseMessage(raw);
          const inTrash = parsed.raw_labels?.includes("TRASH");
          if (inTrash) {
            await supabaseAdmin.from("emails").delete().eq("id", row.id);
            deleted++;
            continue;
          }
          await supabaseAdmin.from("emails").update({
            from_addr: parsed.from_addr,
            from_name: parsed.from_name,
            to_addrs: parsed.to_addrs,
            subject: parsed.subject,
            snippet: parsed.snippet,
            body_text: parsed.body_text,
            body_html: parsed.body_html,
            received_at: parsed.received_at,
            has_attachment: parsed.has_attachment,
            raw_labels: parsed.raw_labels,
            is_read: parsed.is_read,
            is_archived: !parsed.raw_labels?.includes("INBOX"),
          }).eq("id", row.id);
          if (!parsed.raw_labels?.includes("INBOX")) archived++;
          repaired++;
          continue;
        } catch (e: any) {
          if (typeof e?.message === "string" && e.message.includes("404")) {
            await supabaseAdmin.from("emails").delete().eq("id", row.id);
            deleted++;
            continue;
          }
          throw e;
        }
      }

      const labels = await getMessageLabels(accountId, row.gmail_message_id);
      if (labels === null) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      const patch: { raw_labels?: string[]; is_archived?: boolean; is_read?: boolean } = {};
      const inInbox = labels.includes("INBOX");
      const inTrash = labels.includes("TRASH");
      if (inTrash) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      if (!inInbox) {
        patch.is_archived = true;
        archived++;
      }
      patch.raw_labels = labels;
      patch.is_read = !labels.includes("UNREAD");
      await supabaseAdmin.from("emails").update(patch).eq("id", row.id);
      if (!patch.is_archived) updated++;
    } catch (e) {
      failed++;
      console.error("reconcile row failed", row.gmail_message_id, e);
    }
  }

  // Second pass: scan the most recent archived rows for "moved back to inbox in Gmail"
  // or "marked unread in Gmail" changes that the history poll missed. Cheap label-only fetches.
  let unarchived = 0;
  const { data: archivedRows } = await supabaseAdmin
    .from("emails")
    .select("id, gmail_message_id, raw_labels, is_read, folder_id")
    .eq("gmail_account_id", accountId)
    .eq("is_archived", true)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(200);
  for (const row of archivedRows ?? []) {
    try {
      const labels = await getMessageLabels(accountId, row.gmail_message_id);
      if (labels === null) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      if (labels.includes("TRASH")) {
        await supabaseAdmin.from("emails").delete().eq("id", row.id);
        deleted++;
        continue;
      }
      const inInbox = labels.includes("INBOX");
      const unread = labels.includes("UNREAD");
      const patch: { raw_labels?: string[]; is_archived?: boolean; is_read?: boolean } = {
        raw_labels: labels,
      };
      if (inInbox) {
        patch.is_archived = false;
        unarchived++;
      }
      if (row.is_read !== !unread) {
        patch.is_read = !unread;
      }
      await supabaseAdmin.from("emails").update(patch).eq("id", row.id);
    } catch (e) {
      failed++;
      console.error("reconcile archived row failed", row.gmail_message_id, e);
    }
  }

  return { checked: rows?.length ?? 0, archived, deleted, updated, repaired, failed, archived_checked: archivedRows?.length ?? 0, unarchived };
}

/**
 * Pull the NEXT page of historical messages from the folder's linked Gmail label
 * and ingest any we don't already have. Uses a per-folder cursor (pageToken +
 * oldest received_at) stored on the folders row, so repeated calls walk backwards
 * through the label.
 */
export async function loadOlderFromLabel(
  folderId: string,
  userId: string,
  beforeReceivedAt: string | null
) {
  const { data: folderRow } = await supabaseAdmin
    .from("folders")
    .select(
      "id, user_id, name, gmail_label_id, gmail_account_id, gmail_backfill_page_token, gmail_backfill_oldest_received_at"
    )
    .eq("id", folderId)
    .single();
  if (!folderRow) throw new Error("Folder not found");
  const folder = folderRow;
  if (folder.user_id !== userId) throw new Error("Not authorized");
  if (!folder.gmail_label_id) {
    return { ingested: 0, hasMore: false, reason: "no_label" as const };
  }

  // Prefer the stored pageToken when it lines up with the caller's cursor.
  // Otherwise fall back to a Gmail `before:` query anchored to the cursor,
  // so we always retrieve messages older than what's local.
  let pageToken: string | undefined;
  let q: string | undefined;
  const tokenUsable =
    beforeReceivedAt &&
    folder.gmail_backfill_oldest_received_at &&
    new Date(beforeReceivedAt).getTime() <=
      new Date(folder.gmail_backfill_oldest_received_at).getTime() &&
    folder.gmail_backfill_page_token;
  if (tokenUsable) {
    pageToken = folder.gmail_backfill_page_token!;
  } else if (beforeReceivedAt) {
    const secs = Math.floor(new Date(beforeReceivedAt).getTime() / 1000);
    q = `before:${secs}`;
  }

  const list = await listMessages(folder.gmail_account_id, {
    labelIds: [folder.gmail_label_id],
    maxResults: 50,
    pageToken,
    q,
  });
  const ids = (list.messages ?? []).map((m) => m.id);
  let ingested = 0;
  let claimed = 0;
  let oldestSeen: string | null = null;

  if (ids.length > 0) {
    const { data: existing } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, folder_id, received_at")
      .in("gmail_message_id", ids);
    const known = new Map(
      (existing ?? []).map((r) => [r.gmail_message_id, r] as const)
    );
    for (const r of existing ?? []) {
      if (r.received_at && (!oldestSeen || r.received_at < oldestSeen)) {
        oldestSeen = r.received_at;
      }
    }

    const CONCURRENCY = 8;
    async function processOne(id: string) {
      try {
        const k = known.get(id);
        if (k) {
          if (k.folder_id !== folderId) {
            await supabaseAdmin
              .from("emails")
              .update({
                folder_id: folderId,
                classified_by: "gmail_label",
                ai_confidence: 1,
                classification_reason: `Matched Gmail label "${folder.name}"`,
              })
              .eq("id", k.id);
            claimed++;
          }
          return;
        }
        const raw = await getMessageMetadata(folder.gmail_account_id, id);
        const p = parseMessage(raw);
        const { error } = await supabaseAdmin.from("emails").insert({
          user_id: userId,
          gmail_account_id: folder.gmail_account_id,
          gmail_message_id: p.gmail_message_id,
          thread_id: p.thread_id,
          from_addr: p.from_addr,
          from_name: p.from_name,
          to_addrs: p.to_addrs,
          subject: p.subject,
          snippet: p.snippet,
          received_at: p.received_at,
          is_read: p.is_read,
          is_archived: !p.raw_labels?.includes("INBOX"),
          has_attachment: p.has_attachment,
          raw_labels: p.raw_labels,
          folder_id: folderId,
          classified_by: "gmail_label",
          ai_confidence: 1,
          classification_reason: `Matched Gmail label "${folder.name}"`,
        });
        if (!error) {
          ingested++;
          if (p.received_at && (!oldestSeen || p.received_at < oldestSeen)) {
            oldestSeen = p.received_at;
          }
        }
      } catch (e) {
        console.error("loadOlderFromLabel one failed", id, e);
      }
    }
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(ids.slice(i, i + CONCURRENCY).map(processOne));
    }
  }

  // If we used a stale pageToken and got nothing new, clear it so the next
  // click falls through to the date-anchored query path.
  const clearStaleToken =
    !!pageToken && ingested === 0 && claimed === 0;

  const hasMore = !!list.nextPageToken;
  await supabaseAdmin
    .from("folders")
    .update({
      gmail_backfill_page_token: clearStaleToken ? null : (list.nextPageToken ?? null),
      gmail_backfill_oldest_received_at:
        oldestSeen ?? folder.gmail_backfill_oldest_received_at ?? null,
    })
    .eq("id", folderId);

  return { ingested, claimed, hasMore };
}
