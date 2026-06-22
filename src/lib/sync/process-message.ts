// Single-message processing pipeline. Called by the worker queue
// (runMessageJobs) for every message that arrives via push, poll, or
// backfill. Owns the full lifecycle:
//
//   1. Repair existing row when sync fills in missing body/headers.
//   2. Re-classify existing rows stuck in 'pending'/'pending_ai' (a
//      retried job lands here after an AI failure).
//   3. Classify rules-first (override → label → filters) BEFORE the
//      insert: rule-matched mail lands in its folder in a single
//      INSERT — one realtime event, no flash through the Inbox.
//   4. Mail that needs AI inserts with folder_id=null +
//      classified_by='pending_ai' so it's visible in Inbox immediately,
//      then the AI pass UPDATEs it.
//   5. Apply folder actions: auto-archive, auto-mark-read, auto-star,
//      snooze, forward. Forward failures schedule a retry via
//      forward_next_retry_at; the retry-forward cron picks them up.
//
// PUBLISH-TIME TELEMETRY
//   When the worker claims a job whose row carries published_at_ms (set
//   by the webhook when it enqueued), processGmailMessage persists it
//   onto emails.published_at_ms so get_sync_latency_stats() can compute
//   push → visible latency.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getMessage,
  modifyMessage,
  parseMessage,
  sendMessage,
} from "../gmail.server";
import type { AccountContext } from "./account-context";
import { loadAccountContext } from "./account-context";
import { jitter } from "./backoff";
import { classifyByRules, classifyByAi, type ClassificationResult } from "./classify";
import { bumpEmailsSinceLearn } from "./folder-learn";
import { upsertEmailEncrypted, updateEmailEncrypted } from "./encrypted-writer";

export type ProcessTimings = { fetch: number; ai: number; db: number };

/** The folder fields needed to apply post-classification actions. The
 * prefetched AccountContext folder shape is a superset of this. */
export type ActionFolder = {
  id: string;
  gmail_label_id: string | null;
  auto_archive: boolean;
  auto_mark_read: boolean;
  auto_star: boolean;
  hide_from_inbox: boolean;
  forward_to: string | null;
  snooze_hours: number;
};

function resolveFolderFromContext(context: AccountContext | undefined, folderId: string): ActionFolder | null {
  const cached = context?.folders.find((f) => f.id === folderId);
  if (!cached) return null;
  return {
    id: cached.id,
    gmail_label_id: cached.gmail_label_id,
    auto_archive: cached.auto_archive,
    auto_mark_read: cached.auto_mark_read,
    auto_star: cached.auto_star,
    hide_from_inbox: cached.hide_from_inbox,
    forward_to: cached.forward_to,
    snooze_hours: cached.snooze_hours,
  };
}

async function fetchActionFolder(folderId: string): Promise<ActionFolder | null> {
  const { data } = await supabaseAdmin
    .from("folders")
    .select("id, gmail_label_id, auto_archive, auto_mark_read, auto_star, hide_from_inbox, forward_to, snooze_hours")
    .eq("id", folderId)
    .maybeSingle();
  return data ?? null;
}

/** Gmail label mutations + local flag effects for routing into `folder`.
 * Single source of truth so the insert path and the post-hoc patch path
 * can't diverge. */
function computeFolderEffects(folder: ActionFolder, parsed: { raw_labels: string[] | null }, inInbox: boolean) {
  // hide_from_inbox behaves like auto_archive for the inbox view.
  const effectiveArchive = folder.auto_archive || folder.hide_from_inbox;
  const addLabels: string[] = [];
  const removeLabels: string[] = [];
  if (folder.gmail_label_id && !parsed.raw_labels?.includes(folder.gmail_label_id)) addLabels.push(folder.gmail_label_id);
  if (folder.auto_mark_read) removeLabels.push("UNREAD");
  if (folder.auto_star && !parsed.raw_labels?.includes("STARRED")) addLabels.push("STARRED");
  if (inInbox && effectiveArchive) removeLabels.push("INBOX");
  const snoozedUntil =
    folder.snooze_hours && folder.snooze_hours > 0
      ? new Date(Date.now() + folder.snooze_hours * 3600_000).toISOString()
      : null;
  return { effectiveArchive, addLabels, removeLabels, snoozedUntil };
}

/** Apply Gmail label changes, auto-forward, and (optionally) the local
 * flag patch for an email routed into `folder`.
 *
 * persistFlags=false → the caller already wrote is_archived / is_read /
 * snoozed_until in the INSERT; only Gmail mutations + forward state run.
 * persistFlags=true  → patch those flags onto the existing row (the AI
 * path and the rescue sweep, where classification lands post-insert). */
export async function applyFolderActions(
  accountId: string,
  gmailId: string,
  emailRowId: string,
  folder: ActionFolder,
  parsed: {
    raw_labels: string[] | null;
    subject: string;
    from_addr: string;
    from_name: string;
    received_at: string;
    body_text: string;
    snippet: string;
  },
  inInbox: boolean,
  opts: { persistFlags: boolean },
) {
  const { effectiveArchive, addLabels, removeLabels, snoozedUntil } = computeFolderEffects(folder, parsed, inInbox);

  if (addLabels.length || removeLabels.length) {
    try { await modifyMessage(accountId, gmailId, addLabels, removeLabels); }
    catch (e) { console.error("modify failed", e); }
  }

  const patch: {
    is_archived?: boolean;
    is_read?: boolean;
    snoozed_until?: string;
    forwarded_to?: string;
    forwarded_at?: string;
    forward_attempts?: number;
    forward_last_error?: string | null;
    forward_next_retry_at?: string | null;
  } = {};
  if (opts.persistFlags) {
    if (inInbox && effectiveArchive) patch.is_archived = true;
    if (folder.auto_mark_read) patch.is_read = true;
    if (snoozedUntil) patch.snoozed_until = snoozedUntil;
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
      // Clear any pending retry state from previous failures.
      patch.forward_attempts = 0;
      patch.forward_last_error = null;
      patch.forward_next_retry_at = null;
    } catch (e) {
      // Schedule a retry instead of silently dropping. Counter +
      // next_retry_at are picked up by retryForwardAttempts.
      const errMsg = (e as Error)?.message?.slice(0, 500) ?? "unknown";
      console.error("auto-forward failed; scheduling retry", errMsg);
      const nextRetry = new Date(Date.now() + jitter(60) * 1000).toISOString();
      patch.forward_attempts = 1;
      patch.forward_last_error = errMsg;
      patch.forward_next_retry_at = nextRetry;
    }
  }
  if (Object.keys(patch).length > 0) {
    await supabaseAdmin.from("emails").update(patch).eq("id", emailRowId);
  }
}

/** Persist a classification outcome onto an existing email row via the
 * encrypted-write RPC. Sensitive fields (ai_summary, classification_reason)
 * are encrypted; folder_id/ai_confidence/classified_by/matched_* are plain.
 * The RPC treats a null folder_id as "leave unchanged" — every caller here
 * runs against a row whose folder_id is already null, so a null outcome
 * correctly leaves it in the Inbox. */
async function persistClassification(emailId: string, c: ClassificationResult) {
  await updateEmailEncrypted({
    email_id: emailId,
    folder_id: c.folder_id,
    ai_summary: c.ai_summary || null,
    ai_confidence: c.ai_confidence,
    classified_by: c.classified_by,
    classification_reason: c.classification_reason,
    matched_filter_ids: c.matched_filter_ids,
    matched_folder_ids: c.matched_folder_ids,
  });
}

export async function processGmailMessage(
  accountId: string,
  gmailId: string,
  userId: string,
  opts: {
    context?: AccountContext;
    skipAi?: boolean;
    timings?: ProcessTimings;
    /** Caller already has a parsed message. Pass it here to skip the
     * duplicate Gmail roundtrip. */
    prefetched?: ReturnType<typeof parseMessage>;
    /** Pub/Sub publish time (ms epoch) for the push that originated
     * this job. Persisted onto the inserted email row so we can compute
     * push → visible latency. Comes from message_jobs.published_at_ms
     * when runMessageJobs invokes us. */
    publishedAtMs?: number | null;
  } = {},
) {
  const t = opts.timings;

  const _t0 = performance.now();
  // Check body/subject presence via the encrypted columns — the plaintext
  // columns were dropped (Phase 3 encryption). Presence of *_enc ciphertext
  // is enough to decide whether the row needs repair.
  const { data: existing } = await supabaseAdmin
    .from("emails")
    .select("id, from_addr, subject_enc, body_text_enc, body_html_enc, received_at, classified_by, folder_id")
    .eq("gmail_message_id", gmailId)
    .eq("gmail_account_id", accountId)
    .maybeSingle();
  if (t) t.db += performance.now() - _t0;

  let parsed: ReturnType<typeof parseMessage>;
  if (opts.prefetched) {
    parsed = opts.prefetched;
  } else {
    const _t1 = performance.now();
    const raw = await getMessage(accountId, gmailId);
    parsed = parseMessage(raw);
    if (t) t.fetch += performance.now() - _t1;
  }

  if (existing) {
    // Repair rows that were inserted with missing/blank metadata.
    const needsRepair =
      !existing.from_addr ||
      !existing.subject_enc ||
      (!existing.body_text_enc && !existing.body_html_enc) ||
      !existing.received_at;
    if (needsRepair) {
      // Sensitive fields go through the encrypted-write RPC; the plaintext
      // base columns (from_addr, received_at, flags, labels) update directly.
      await updateEmailEncrypted({
        email_id: existing.id,
        from_name: parsed.from_name,
        to_addrs: parsed.to_addrs,
        subject: parsed.subject,
        snippet: parsed.snippet,
        body_text: parsed.body_text,
        body_html: parsed.body_html,
      });
      await supabaseAdmin.from("emails").update({
        from_addr: parsed.from_addr,
        received_at: parsed.received_at,
        has_attachment: parsed.has_attachment,
        raw_labels: parsed.raw_labels,
        is_read: parsed.is_read,
      }).eq("id", existing.id);
      return { repaired: true };
    }

    // Row exists but classification never completed (AI failure, worker
    // killed mid-job, deferred backfill). A retried job lands here —
    // re-run classification instead of skipping, otherwise retries are
    // no-ops and the email is stranded in Inbox forever.
    const stuckPending =
      (existing.classified_by === "pending" || existing.classified_by === "pending_ai") &&
      !existing.folder_id;
    if (stuckPending) {
      const context = opts.context ?? (await loadAccountContext(accountId, userId));
      const rules = classifyByRules(parsed, context);
      if (rules.needs_ai && opts.skipAi) {
        // AI still deferred (backfill lane) — leave the row pending and
        // signal the caller to queue it for the batched AI pass.
        return { id: existing.id, email_id: existing.id, folder_id: null, parsed, needs_ai: true };
      }
      const _tAi = performance.now();
      const final = rules.needs_ai ? await classifyByAi(parsed, context, rules) : rules;
      if (t) t.ai += performance.now() - _tAi;
      if (final.folder_id) {
        const folder =
          resolveFolderFromContext(context, final.folder_id) ?? (await fetchActionFolder(final.folder_id));
        if (folder) {
          const inInboxNow = (parsed.raw_labels ?? []).includes("INBOX");
          await applyFolderActions(accountId, gmailId, existing.id, folder, parsed, inInboxNow, { persistFlags: true });
        }
        void bumpEmailsSinceLearn(final.folder_id);
      }
      await persistClassification(existing.id, final);
      return { id: existing.id, email_id: existing.id, folder_id: final.folder_id, parsed, reclassified: true };
    }

    return { skipped: true };
  }

  const labels = parsed.raw_labels ?? [];
  const EXCLUDED_LABELS = ["SENT", "DRAFT", "TRASH", "SPAM", "CHAT"];
  if (EXCLUDED_LABELS.some((l) => labels.includes(l))) return { skipped: true };
  const inInbox = labels.includes("INBOX");

  const publishedAtMs = opts.publishedAtMs ?? null;

  // 1) Rules-first classification BEFORE the insert. Cheap (10–50ms, no
  //    AI). Rule-matched mail inserts with its final folder + flags in
  //    one statement: one realtime INSERT straight into the folder, no
  //    flash through the Inbox, no second UPDATE event.
  const _tRules = performance.now();
  const context = opts.context ?? (await loadAccountContext(accountId, userId));
  const rules = classifyByRules(parsed, context);
  if (t) t.ai += performance.now() - _tRules;
  const aiDeferred = rules.needs_ai && Boolean(opts.skipAi);

  // Resolve folder + effects up-front when rules already routed the mail.
  let rulesFolder: ActionFolder | null = null;
  if (!rules.needs_ai && rules.folder_id) {
    rulesFolder =
      resolveFolderFromContext(context, rules.folder_id) ?? (await fetchActionFolder(rules.folder_id));
  }
  const rulesEffects = rulesFolder ? computeFolderEffects(rulesFolder, parsed, inInbox) : null;

  const _tIns = performance.now();
  const isArchived = rules.needs_ai
    ? !inInbox
    : (!inInbox || (rulesEffects?.effectiveArchive ?? false));
  const isReadFlag = rules.needs_ai
    ? parsed.is_read
    : (parsed.is_read || (rulesFolder?.auto_mark_read ?? false));

  // Insert via the encrypted-write RPC (sensitive columns are encrypted at
  // rest). It forces folder_id=null and can't carry classification
  // metadata, so the rules-final / pending_ai metadata is applied in a
  // follow-up write below.
  const { id: insertedId, error } = await upsertEmailEncrypted({
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
    is_read: isReadFlag,
    is_archived: isArchived,
    has_attachment: parsed.has_attachment,
    raw_labels: parsed.raw_labels,
    classified_by: rules.needs_ai ? "pending_ai" : rules.classified_by,
    processed_at: new Date().toISOString(),
    published_at_ms: publishedAtMs,
  });
  if (t) t.db += performance.now() - _tIns;

  if (error || !insertedId) {
    console.error("insert email failed", error);
    return { error: error ?? "insert failed" };
  }
  const inserted = { id: insertedId };

  if (rules.needs_ai) {
    if (rules.classification_reason) {
      await updateEmailEncrypted({ email_id: insertedId, classification_reason: rules.classification_reason });
    }
  } else {
    await persistClassification(insertedId, rules);
    if (rulesEffects?.snoozedUntil) {
      await supabaseAdmin.from("emails").update({ snoozed_until: rulesEffects.snoozedUntil }).eq("id", insertedId);
    }
  }

  // 2) Rules-final path: Gmail label mutations + forward. Flags are
  //    already in the row from the INSERT.
  if (!rules.needs_ai) {
    if (rules.folder_id) {
      void bumpEmailsSinceLearn(rules.folder_id);
      if (rulesFolder) {
        await applyFolderActions(accountId, gmailId, inserted.id, rulesFolder, parsed, inInbox, { persistFlags: false });
      }
    }
    return { id: inserted.id, email_id: inserted.id, folder_id: rules.folder_id, parsed, needs_ai: false };
  }

  // 3) Backfill lane: defer AI to the caller's batched pass.
  if (aiDeferred) {
    return { id: inserted.id, email_id: inserted.id, folder_id: null, parsed, needs_ai: true };
  }

  // 4) AI pass. The email is already visible in Inbox, so a slow or
  //    failed call costs classification latency, not visibility.
  let folder_id: string | null = null;
  try {
    const _tAi = performance.now();
    const c = await classifyByAi(parsed, context, rules);
    if (t) t.ai += performance.now() - _tAi;
    folder_id = c.folder_id ?? null;
    if (folder_id) {
      const folder = resolveFolderFromContext(context, folder_id) ?? (await fetchActionFolder(folder_id));
      if (folder) {
        await applyFolderActions(accountId, gmailId, inserted.id, folder, parsed, inInbox, { persistFlags: true });
      }
    }
    const _tDb = performance.now();
    await persistClassification(inserted.id, c);
    if (folder_id) void bumpEmailsSinceLearn(folder_id);
    if (t) t.db += performance.now() - _tDb;
  } catch (e) {
    console.error("classify failed (email already visible in Inbox)", e);
    await updateEmailEncrypted({
      email_id: inserted.id,
      classified_by: "unclassified",
      classification_reason: `Classification failed: ${(e as Error)?.message?.slice(0, 200) ?? "unknown"}`,
    });
    return { id: inserted.id, classify_failed: true };
  }

  return { id: inserted.id, email_id: inserted.id, folder_id, parsed, needs_ai: false };
}
