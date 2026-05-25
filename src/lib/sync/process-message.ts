// Single-message processing pipeline. Called by the worker queue
// (runMessageJobs) for every message that arrives via push, poll, or
// backfill. Owns the full lifecycle:
//
//   1. Repair existing row when sync fills in missing body/headers.
//   2. Insert a new row (folder_id=null) so the message is visible in
//      Inbox immediately — classification is a separate UPDATE so a
//      slow AI call doesn't block visibility.
//   3. Classify (folder rules → AI fallback) via classifyParsedEmail.
//   4. Apply folder actions: auto-archive, auto-mark-read, auto-star,
//      snooze, forward. Forward failures schedule a retry via
//      forward_next_retry_at; the retry-forward cron picks them up.
//
// PUBLISH-TIME TELEMETRY
//   When the worker claims a job whose row carries published_at_ms (set
//   by the webhook when it enqueued), processGmailMessage persists it
//   onto emails.published_at_ms so get_sync_latency_stats() can compute
//   push → visible latency.
//
// PREFETCH SHORTCUT
//   The history-sync labelsAdded handler already fetched the message
//   for recordManualMove; it passes the parsed result via opts.prefetched
//   so we skip the duplicate Gmail roundtrip.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  getMessage,
  modifyMessage,
  parseMessage,
  sendMessage,
} from "../gmail.server";
import type { AccountContext } from "./account-context";
import { jitter } from "./backoff";
import { classifyParsedEmail } from "./classify";
import { bumpEmailsSinceLearn } from "./folder-learn";

export type ProcessTimings = { fetch: number; ai: number; db: number };

export async function processGmailMessage(
  accountId: string,
  gmailId: string,
  userId: string,
  opts: {
    context?: AccountContext;
    skipAi?: boolean;
    timings?: ProcessTimings;
    /** Caller already has a parsed message (e.g. syncSinceHistory had
     * to fetch it to record a manual move). Pass it here to skip the
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
  // Check body presence via the encrypted columns. Plaintext body_text /
  // body_html columns are zeroed by the emails_encrypt_body BEFORE
  // trigger, so reading them would always look empty.
  const { data: existing } = await supabaseAdmin
    .from("emails")
    .select("id, from_addr, subject, body_text_encrypted, body_html_encrypted, received_at")
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
      !existing.subject ||
      (!existing.body_text_encrypted && !existing.body_html_encrypted) ||
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

  const publishedAtMs = opts.publishedAtMs ?? null;

  // 1) Insert the email row FIRST with no folder so it shows up in
  //    Inbox immediately, even if classification (AI Gateway) is slow
  //    or fails. Classification runs in step 2 and UPDATEs the row.
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
      published_at_ms: publishedAtMs,
    })
    .select("id")
    .single();

  if (error) {
    console.error("insert email failed", error);
    return { error: error.message };
  }

  // 2) Classify. If this throws or times out, the email is already in
  //    Inbox.
  let folder_id: string | null = null;
  try {
    const _tAi = performance.now();
    const c = await classifyParsedEmail(parsed, userId, accountId, {
      context: opts.context,
      skipAi: opts.skipAi,
    });
    if (t) t.ai += performance.now() - _tAi;
    folder_id = c.folder_id ?? null;
    const _tDb = performance.now();
    await supabaseAdmin.from("emails").update({
      folder_id,
      ai_summary: c.ai_summary || null,
      ai_confidence: c.ai_confidence,
      classified_by: c.classified_by,
      classification_reason: c.classification_reason,
      matched_filter_ids: c.matched_filter_ids,
      matched_folder_ids: c.matched_folder_ids,
    }).eq("id", inserted.id);
    if (folder_id) void bumpEmailsSinceLearn(folder_id);
    if (t) t.db += performance.now() - _tDb;
  } catch (e) {
    console.error("classify failed (email already visible in Inbox)", e);
    await supabaseAdmin.from("emails").update({
      classified_by: "unclassified",
      classification_reason: `Classification failed: ${(e as Error)?.message?.slice(0, 200) ?? "unknown"}`,
    }).eq("id", inserted.id);
    return { id: inserted.id, classify_failed: true };
  }

  // 3) Apply Gmail label / auto-archive / auto-mark-read for the
  //    assigned folder. Use the prefetched folder list when available
  //    to avoid an extra DB round trip.
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
        await supabaseAdmin.from("emails").update(patch).eq("id", inserted.id);
      }
    }
  }

  return { id: inserted.id, email_id: inserted.id, folder_id, parsed };
}
