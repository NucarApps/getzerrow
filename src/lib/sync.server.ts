// Core sync pipeline: pull messages for a specific gmail_account, apply filters/AI,
// persist, apply Gmail label/actions. Server-only.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getMessage, getMessageMetadata, modifyMessage, parseMessage, listMessages, listHistory, ensureWatch, getMessageLabels } from "./gmail.server";
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
    case "not_contains": return !fieldVal.includes(v);
    case "not_equals": return fieldVal !== v;
    case "regex":
      try { return new RegExp(f.value, "i").test(fieldVal); } catch { return false; }
    default: return false;
  }
}

const EXCLUDE_OPS = new Set(["not_contains", "not_equals"]);

type FolderMatch =
  | { kind: "match"; folder_id: string; filter: Filter; matched_filters: Filter[] }
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
  const matched: Array<{ folder: Folder; filter: Filter; allMatches: Filter[] }> = [];
  const excludedFolders: Array<{ folder: Folder; exclude: Filter }> = [];
  for (const folder of folders) {
    const fs = byFolder.get(folder.id) || [];
    if (fs.length === 0) continue;
    const includes = fs.filter((f) => !EXCLUDE_OPS.has(f.op));
    const excludes = fs.filter((f) => EXCLUDE_OPS.has(f.op));
    const includeHits = includes.filter((f) => applyFilter(email, f));
    if (includeHits.length === 0) continue;
    const excludeHit = excludes.find((f) => applyFilter(email, f));
    if (excludeHit) {
      excludedFolders.push({ folder, exclude: excludeHit });
      continue;
    }
    matched.push({ folder, filter: includeHits[0], allMatches: includeHits });
  }
  if (matched.length > 0) {
    matched.sort((a, b) => b.folder.priority - a.folder.priority);
    return { kind: "match", folder_id: matched[0].folder.id, filter: matched[0].filter, matched_filters: matched[0].allMatches };
  }
  if (excludedFolders.length > 0) {
    excludedFolders.sort((a, b) => b.folder.priority - a.folder.priority);
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
};

export async function classifyParsedEmail(
  parsed: {
    from_addr: string;
    from_name: string;
    to_addrs: string;
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
  opts: { skipGmailLabelMatch?: boolean } = {},
): Promise<ClassificationResult> {
  const [{ data: folders }, { data: filters }, { data: overrides }] = await Promise.all([
    supabaseAdmin.from("folders").select("*").eq("gmail_account_id", accountId).order("priority", { ascending: false }),
    supabaseAdmin.from("folder_filters").select("id, folder_id, field, op, value"),
    supabaseAdmin.from("inbox_overrides").select("match_type, value").eq("user_id", userId),
  ]);

  const folderList = (folders ?? []) as Folder[];
  const folderIds = new Set(folderList.map((f) => f.id));
  const filterList = ((filters ?? []) as Filter[]).filter((f) => folderIds.has(f.folder_id));

  let folder_id: string | null = null;
  let classified_by = "none";
  let confidence = 0;
  let summary = "";
  let classification_reason: string | null = null;
  let matched_filter_ids: string[] = [];
  let aiSkipped = false;

  const fromAddr = (parsed.from_addr || "").toLowerCase();
  const fromDomain = fromAddr.split("@")[1] || "";
  const overrideHit = (overrides ?? []).find((o) => {
    const val = (o.value || "").toLowerCase();
    return o.match_type === "email" ? val === fromAddr : val === fromDomain;
  });

  if (overrideHit) {
    classified_by = "global_exclude";
    classification_reason = `Global inbox list: ${overrideHit.match_type} "${overrideHit.value}"`;
    aiSkipped = true;
  } else {
    // Gmail label match always wins — if the message already has one of our
    // folder labels at sync time, that's either a manual move in Gmail or a
    // label we previously applied. Either way, we should NOT re-attribute it
    // to a domain/filter rule that happens to also match.
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
        classified_by = m.filter.field === "domain" ? "domain_rule" : "filter";
        confidence = 1;
        matched_filter_ids = m.matched_filters.map((f) => f.id);
        classification_reason =
          classified_by === "domain_rule"
            ? `Domain rule: ${m.filter.value} → ${labelOf(folderList, m.folder_id)}`
            : `Filter: ${m.filter.field} ${m.filter.op} "${m.filter.value}"`;
      } else if (m?.kind === "excluded") {
        classified_by = "excluded";
        classification_reason = `Would match "${m.folder_name}" but excluded by rule: ${m.exclude.field} ${m.exclude.op} "${m.exclude.value}"`;
        aiSkipped = true;
      }
    }
  }

  if (!folder_id && !aiSkipped && folderList.length > 0) {
    try {
      const enriched = await loadFoldersWithExamples(folderList);
      const r = await classifyEmail(parsed, enriched);
      folder_id = r.folder_id;
      confidence = r.confidence;
      summary = r.summary;
      classified_by = "ai";
      classification_reason = r.reason || null;
    } catch (e) {
      console.error("AI classify failed", e);
      classified_by = "ai_error";
      classification_reason = `AI classifier failed: ${(e as Error)?.message ?? "unknown error"}`;
    }
  }

  return {
    folder_id,
    classified_by,
    ai_confidence: confidence,
    ai_summary: summary,
    classification_reason,
    matched_filter_ids,
  };
}

export async function processGmailMessage(accountId: string, gmailId: string, userId: string) {

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

  if (!parsed.raw_labels?.includes("INBOX")) return { skipped: true };

  const c = await classifyParsedEmail(parsed, userId, accountId);
  const folder_id = c.folder_id;
  const classified_by = c.classified_by;
  const confidence = c.ai_confidence;
  const summary = c.ai_summary;
  const classification_reason = c.classification_reason;
  const matched_filter_ids = c.matched_filter_ids;


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
      classification_reason,
      matched_filter_ids,
      processed_at: new Date().toISOString(),
    })
    .select("id, folder_id")
    .single();

  if (error) {
    console.error("insert email failed", error);
    return { error: error.message };
  }

  if (folder_id) {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, gmail_label_id, auto_archive, auto_mark_read")
      .eq("id", folder_id)
      .maybeSingle();
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

  // Single page is enough at this cap (Gmail returns up to 500 ids per page).
  const list = await listMessages(accountId, {
    maxResults: MAX_MESSAGES,
    labelIds: [folder.gmail_label_id],
  });
  const allIds = (list.messages ?? []).map((m) => m.id).slice(0, MAX_MESSAGES);

  // Skip ids we already have as examples for this folder — re-learn becomes near-instant.
  let idsToFetch = allIds;
  if (allIds.length > 0) {
    const { data: known } = await supabaseAdmin
      .from("folder_examples")
      .select("gmail_message_id")
      .eq("folder_id", folderId)
      .in("gmail_message_id", allIds);
    const knownSet = new Set((known ?? []).map((r) => r.gmail_message_id));
    idsToFetch = allIds.filter((id) => !knownSet.has(id));
  }

  let learned = 0;
  let ingested = 0;
  let claimed = 0;

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

export async function enqueueMessageJob(
  accountId: string,
  userId: string,
  gmailMessageId: string,
) {
  // Upsert so the same message is never queued twice. If a job already exists
  // (pending or dlq), do nothing — the worker / retry button owns it from here.
  await supabaseAdmin
    .from("message_jobs")
    .upsert(
      {
        gmail_account_id: accountId,
        gmail_message_id: gmailMessageId,
        user_id: userId,
        status: "pending",
        next_run_at: new Date().toISOString(),
      },
      { onConflict: "gmail_account_id,gmail_message_id", ignoreDuplicates: true },
    );
}

export async function runMessageJobs(limit = 25) {
  // Claim a batch of due jobs. We don't have FOR UPDATE SKIP LOCKED via PostgREST,
  // so we approximate with a timestamp-based lock: only pick rows whose locked_at
  // is null or older than 5 minutes, then mark them running with locked_at=now().
  const lockCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: candidates } = await supabaseAdmin
    .from("message_jobs")
    .select("id, gmail_account_id, gmail_message_id, user_id, attempt")
    .neq("status", "dlq")
    .lte("next_run_at", new Date().toISOString())
    .or(`locked_at.is.null,locked_at.lt.${lockCutoff}`)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  const results: Array<{ id: string; ok: boolean; error?: string; dlq?: boolean }> = [];
  for (const job of candidates ?? []) {
    // Try to claim
    const { data: claimed } = await supabaseAdmin
      .from("message_jobs")
      .update({ status: "running", locked_at: new Date().toISOString() })
      .eq("id", job.id)
      .neq("status", "dlq")
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    try {
      await processGmailMessage(job.gmail_account_id, job.gmail_message_id, job.user_id);
      // Success: remove the job row.
      await supabaseAdmin.from("message_jobs").delete().eq("id", job.id);
      results.push({ id: job.id, ok: true });
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const nextAttempt = (job.attempt ?? 0) + 1;
      const is404 = typeof msg === "string" && msg.includes("404");
      if (is404) {
        // Message was deleted in Gmail before we could fetch it. No point retrying.
        await supabaseAdmin.from("message_jobs").delete().eq("id", job.id);
        results.push({ id: job.id, ok: true });
        continue;
      }
      if (nextAttempt >= MAX_JOB_ATTEMPTS) {
        // Capture preview (from/subject) so the user can see what failed.
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
        const backoff = BACKOFF_SECONDS[Math.min(nextAttempt - 1, BACKOFF_SECONDS.length - 1)];
        await supabaseAdmin.from("message_jobs").update({
          status: "pending",
          attempt: nextAttempt,
          last_error: msg.slice(0, 1000),
          locked_at: null,
          next_run_at: new Date(Date.now() + backoff * 1000).toISOString(),
        }).eq("id", job.id);
        results.push({ id: job.id, ok: false, error: msg });
      }
    }
  }
  return { processed: results.length, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok && !r.dlq).length, dlq: results.filter(r => r.dlq).length };
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
        try { await processGmailMessage(accountId, m.id, account.user_id); } catch (e) { console.error(e); }
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
    .select("id, gmail_message_id, raw_labels, from_addr, subject, body_text, body_html, received_at")
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
    .select("id, gmail_message_id, raw_labels, is_read")
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
      if (row.is_read !== !unread) patch.is_read = !unread;
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
