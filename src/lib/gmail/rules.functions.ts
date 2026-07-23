import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  getOwnedAccount,
  getEmailAccount,
  getOwnedFolder,
  getOwnedSchedule,
  extractDomain,
  drainCatchupRounds,
  restoreEmailToInbox,
  ianaTz,
} from "../gmail-helpers.server";
import { performMove } from "../move-email.server";
import {
  backfillRecent,
  backfillWindow,
  syncSinceHistory,
  learnFromLinkedLabel,
  reconcileLocalInbox,
  loadOlderFromLabel,
  runMessageJobs,
  retryMessageJob,
  enqueueMessageJob,
  startBackfillJob,
  cancelBackfillJob,
  invalidateAccountContext,
  invalidateAccountContextForUser,
  bulkCatchupClaim,
  syncReadState,
} from "../sync.server";
import { CATCHUP_MAX_ROUNDS, CATCHUP_TOTAL_BUDGET_MS } from "../sync/config";
import {
  listLabels,
  createLabel,
  modifyMessage,
  batchModifyMessages,
  trashMessage,
  sendMessage,
  ensureWatch,
  stopWatch,
  listMessages,
  getMessage,
  getMessageMetadata,
  getMessageLabels,
  getThread,
  parseMessage,
} from "../gmail.server";
import {
  suggestReply,
  suggestRuleUpdates,
  suggestFolderFromEmails,
  generateAiRuleFromPurpose,
  generateAiRuleFromLabelSamples,
} from "../ai.server";
import { computeNextRun, enqueueFolderSummaryJob, runFolderSummary } from "../summaries.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signState, buildAuthorizeUrl, getRedirectUri } from "../google-oauth.server";
import { getRequestHost } from "@tanstack/react-start/server";
import { logError, logAudit } from "../log.server";
import { removeLabelsFromCurrent } from "../sync/label-merge";
import { buildGmailQueries } from "../sync/gmail-query-builder";
import { matchByFilters, emailVetoedForFolder } from "../sync/filter-engine";
import type { Folder, Filter, RuleNode } from "../sync/types";
import {
  upsertEmailEncrypted,
  updateEmailEncrypted,
  setReplyDraftEncrypted,
  insertFolderExampleEncrypted,
} from "../sync/encrypted-writer";
import { getEmailsDecrypted } from "../sync/encrypted-reader";
export const getSyncLatencyStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        lookback_hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 7)
          .optional(),
        account_id: z.string().uuid().optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    type LatencyBucket = {
      count: number;
      p50: number | null;
      p95: number | null;
      p99: number | null;
    };
    type LatencyStats = {
      push_to_ack: LatencyBucket;
      push_to_visible: LatencyBucket;
      since: string;
    };
    type LatencyRpc = {
      rpc: (
        fn: "get_sync_latency_stats",
        args: { p_user_id: string; p_lookback_hours: number; p_account_id?: string | null },
      ) => Promise<{ data: LatencyStats | null; error: { message: string } | null }>;
    };
    const { data: stats, error } = await (supabaseAdmin as unknown as LatencyRpc).rpc(
      "get_sync_latency_stats",
      {
        p_user_id: context.userId,
        p_lookback_hours: data.lookback_hours ?? 24,
        p_account_id: data.account_id ?? null,
      },
    );
    if (error) {
      logError("gmail.latency_stats.rpc_failed", { user_id: context.userId }, error);
      return {
        push_to_ack: { count: 0, p50: null, p95: null, p99: null },
        push_to_visible: { count: 0, p50: null, p95: null, p99: null },
        since: new Date(Date.now() - (data.lookback_hours ?? 24) * 3600_000).toISOString(),
        error: error.message,
      } satisfies LatencyStats & { error: string };
    }
    return (
      stats ?? {
        push_to_ack: { count: 0, p50: null, p95: null, p99: null },
        push_to_visible: { count: 0, p50: null, p95: null, p99: null },
        since: new Date(Date.now() - (data.lookback_hours ?? 24) * 3600_000).toISOString(),
      }
    );
  });

/**
 * POST a synthetic envelope to our own Pub/Sub webhook to prove the endpoint
 * is reachable. Tagged with `x-zerrow-test: 1` so the webhook logs it as
 * `webhook_test` and it does NOT pollute real push diagnostics.
 *
 * If `realistic` is true and the user has a connected account, builds a
 * Pub/Sub-shaped envelope using that account's email + current history_id
 * so the test also exercises account matching + sync code.
 */
export const pingPubsubWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ realistic: z.boolean().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const host = getRequestHost();
    const url = `https://${host}/api/public/gmail-webhook`;

    let envelope: Record<string, unknown> = { message: {} };
    let mode: "empty" | "realistic" = "empty";
    let account_email: string | null = null;
    if (data.realistic) {
      const { data: acc } = await supabaseAdmin
        .from("gmail_accounts")
        .select("email_address, history_id")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (acc?.email_address && acc.history_id) {
        const payload = { emailAddress: acc.email_address, historyId: acc.history_id };
        const dataB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
        envelope = {
          message: {
            data: dataB64,
            messageId: `zerrow-test-${Date.now()}`,
            publishTime: new Date().toISOString(),
          },
          subscription: "zerrow-app-side-test",
        };
        mode = "realistic";
        account_email = acc.email_address;
      }
    }

    const started = Date.now();
    const cronSecret = process.env.CRON_SECRET;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-zerrow-test": "1",
    };
    if (cronSecret) headers["authorization"] = `Bearer ${cronSecret}`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
      });
      return {
        url,
        ok: r.ok,
        status: r.status,
        elapsed_ms: Date.now() - started,
        topic_set: !!process.env.GMAIL_PUBSUB_TOPIC,
        mode,
        account_email,
      };
    } catch (e: unknown) {
      return {
        url,
        ok: false,
        status: 0,
        elapsed_ms: Date.now() - started,
        topic_set: !!process.env.GMAIL_PUBSUB_TOPIC,
        mode,
        account_email,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });

/** List processing jobs (queue + DLQ) for the current user. */
export const listMessageJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["pending", "running", "dlq", "all"]).optional(),
        limit: z.number().min(1).max(500).optional(),
        account_id: z.string().uuid().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const limit = data.limit ?? 100;
    let q = supabaseAdmin
      .from("message_jobs")
      .select(
        "id, gmail_account_id, gmail_message_id, attempt, status, next_run_at, last_error, from_addr, subject, created_at, updated_at",
      )
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (data.status && data.status !== "all") q = q.eq("status", data.status);
    if (data.account_id) q = q.eq("gmail_account_id", data.account_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    let aggQ = supabaseAdmin.from("message_jobs").select("status").eq("user_id", context.userId);
    if (data.account_id) aggQ = aggQ.eq("gmail_account_id", data.account_id);
    const { data: agg } = await aggQ;
    const stats = { pending: 0, running: 0, dlq: 0, total: agg?.length ?? 0 };
    for (const r of agg ?? []) {
      if (r.status === "pending") stats.pending++;
      else if (r.status === "running") stats.running++;
      else if (r.status === "dlq") stats.dlq++;
    }
    return { jobs: rows ?? [], stats };
  });

/** Manually retry a DLQ or pending job. */
export const retryJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: job } = await supabaseAdmin
      .from("message_jobs")
      .select("id, user_id")
      .eq("id", data.id)
      .maybeSingle();
    if (!job || job.user_id !== context.userId) throw new Error("Not found");
    await retryMessageJob(data.id);
    return { ok: true };
  });

/** Run the worker now (drains up to N jobs). Useful for "Retry now" UI button. */
export const runJobsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ limit: z.number().min(1).max(100).optional() }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    return await runMessageJobs(data.limit ?? 25);
  });

/** Re-enqueue a single Gmail message id for the current user's connected accounts. */
export const enqueueGmailMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { gmail_account_id: string; gmail_message_id: string }) =>
    z
      .object({
        gmail_account_id: z.string().uuid(),
        gmail_message_id: z.string().min(1).max(64),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: acc } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, user_id")
      .eq("id", data.gmail_account_id)
      .maybeSingle();
    if (!acc || acc.user_id !== context.userId) throw new Error("Not found");
    await enqueueMessageJob(data.gmail_account_id, context.userId, data.gmail_message_id);
    return { ok: true };
  });

export const addFolderRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      folder_id: string;
      field: "from" | "domain" | "subject";
      value: string;
      op?: "contains" | "equals" | "starts_with";
    }) =>
      z
        .object({
          folder_id: z.string().uuid(),
          field: z.enum(["from", "domain", "subject"]),
          value: z.string().min(1).max(998),
          op: z.enum(["contains", "equals", "starts_with"]).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const op = data.op ?? (data.field === "subject" ? "starts_with" : "contains");
    // Domain values are normalized (lowercase, no leading @). Sender addresses are
    // lowercased. Subject text is preserved as the user typed it (case-insensitive
    // compare happens in the filter engine).
    const value =
      data.field === "subject"
        ? data.value.trim()
        : data.field === "domain"
          ? data.value.trim().toLowerCase().replace(/^@/, "")
          : data.value.trim().toLowerCase();
    if (!value) throw new Error("Empty value");

    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name, gmail_account_id")
      .eq("id", data.folder_id)
      .maybeSingle();
    if (!folder || folder.user_id !== context.userId) throw new Error("Folder not found");

    const { data: existing } = await supabaseAdmin
      .from("folder_filters")
      .select("id")
      .eq("folder_id", data.folder_id)
      .eq("field", data.field)
      .eq("op", op)
      .eq("value", value)
      .maybeSingle();
    const already = !!existing;
    if (!already) {
      const { error } = await supabaseAdmin.from("folder_filters").insert({
        folder_id: data.folder_id,
        field: data.field,
        op,
        value,
      });
      if (error) throw new Error(error.message);
      invalidateAccountContext(folder.gmail_account_id);
    }
    return { ok: true, already, folder_name: folder.name };
  });

/**
 * Count emails in the given Gmail account that would match a folder rule
 * (field/op/value). Used by FilterLikeThisDrawer's live preview. Caps at 500.
 */
export const countMatchingForRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      account_id: string;
      field: "from" | "domain" | "subject";
      op: "contains" | "equals" | "starts_with";
      value: string;
    }) =>
      z
        .object({
          account_id: z.string().uuid(),
          field: z.enum(["from", "domain", "subject"]),
          op: z.enum(["contains", "equals", "starts_with"]),
          value: z.string().min(1).max(998),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const raw = data.value.trim();
    if (!raw) return { count: 0 };
    const v = data.field === "subject" ? raw : raw.toLowerCase().replace(/^@/, "");
    const esc = v.replace(/[\\%_]/g, (m) => `\\${m}`);
    let q = supabaseAdmin
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("gmail_account_id", data.account_id);

    if (data.field === "subject") {
      const pat = data.op === "equals" ? esc : data.op === "starts_with" ? `${esc}%` : `%${esc}%`;
      q = q.ilike("subject", pat);
    } else if (data.field === "domain") {
      q = q.ilike("from_addr", `%@${esc}%`);
    } else {
      const pat = data.op === "starts_with" ? `${esc}%` : `%${esc}%`;
      q = q.ilike("from_addr", pat);
    }

    const { count, error } = await q;
    if (error) throw new Error(error.message);
    return { count: count ?? 0 };
  });

/**
 * Apply an existing/just-created folder rule to past matching emails: move
 * them into the target folder. Used by FilterLikeThisDrawer when the user
 * picks "Future and past". Caps at 500 rows per call.
 */
export const applyFilterRuleToPast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      account_id: string;
      to_folder_id: string;
      field: "from" | "domain" | "subject";
      op: "contains" | "equals" | "starts_with";
      value: string;
      archive?: boolean;
    }) =>
      z
        .object({
          account_id: z.string().uuid(),
          to_folder_id: z.string().uuid(),
          field: z.enum(["from", "domain", "subject"]),
          op: z.enum(["contains", "equals", "starts_with"]),
          value: z.string().min(1).max(998),
          archive: z.boolean().optional().default(false),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name")
      .eq("id", data.to_folder_id)
      .maybeSingle();
    if (!folder || folder.user_id !== context.userId) throw new Error("Folder not found");

    const raw = data.value.trim();
    if (!raw) return { moved: 0, failed: 0, archived: 0 };
    const v = data.field === "subject" ? raw : raw.toLowerCase().replace(/^@/, "");
    const esc = v.replace(/[\\%_]/g, (m) => `\\${m}`);

    // Build a query with the rule predicate applied (without folder/archive scoping).
    const applyRulePredicate = <T extends { ilike(column: string, pattern: string): T }>(
      qb: T,
    ): T => {
      if (data.field === "subject") {
        const pat = data.op === "equals" ? esc : data.op === "starts_with" ? `${esc}%` : `%${esc}%`;
        return qb.ilike("subject", pat);
      } else if (data.field === "domain") {
        return qb.ilike("from_addr", `%@${esc}%`);
      } else {
        const pat = data.op === "starts_with" ? `${esc}%` : `%${esc}%`;
        return qb.ilike("from_addr", pat);
      }
    };

    // Move pass: rows matching the rule that aren't already in the target folder.
    const moveQ = applyRulePredicate(
      supabaseAdmin
        .from("emails")
        .select("id")
        .eq("user_id", context.userId)
        .eq("gmail_account_id", data.account_id)
        .neq("folder_id", data.to_folder_id)
        .order("received_at", { ascending: false })
        .limit(500),
    );
    const { data: rows, error } = await moveQ;
    if (error) throw new Error(error.message);

    const classifiedBy = data.field === "domain" ? "domain_rule" : "filter";
    const reason =
      data.field === "domain"
        ? `Domain rule: ${v} → ${folder.name}`
        : data.field === "subject"
          ? `Subject rule (${data.op}): ${v} → ${folder.name}`
          : `Sender rule: ${v} → ${folder.name}`;

    let moved = 0;
    let failed = 0;
    const movedIds: string[] = [];
    for (const row of rows ?? []) {
      const r = await performMove(context.userId, row.id, data.to_folder_id, reason);
      if (r.ok) {
        moved++;
        movedIds.push(row.id);
      } else failed++;
    }
    if (moved > 0) {
      await supabaseAdmin
        .from("emails")
        .update({ classified_by: classifiedBy })
        .eq("user_id", context.userId)
        .in("id", movedIds)
        .eq("folder_id", data.to_folder_id);
    }

    // Archive pass: every matching row currently in the inbox, regardless of
    // whether it was moved in this run or was already in the target folder.
    let archived = 0;
    if (data.archive) {
      const archQ = applyRulePredicate(
        supabaseAdmin
          .from("emails")
          .select("id, gmail_message_id, raw_labels")
          .eq("user_id", context.userId)
          .eq("gmail_account_id", data.account_id)
          .eq("is_archived", false)
          .order("received_at", { ascending: false })
          .limit(500),
      );
      const { data: archRows } = await archQ;
      const targetRows = (archRows ?? []) as Array<{
        id: string;
        gmail_message_id: string | null;
        raw_labels: string[] | null;
      }>;
      const gmailIds = targetRows.map((r) => r.gmail_message_id).filter(Boolean) as string[];
      if (gmailIds.length > 0) {
        try {
          await batchModifyMessages(data.account_id, gmailIds, [], ["INBOX"]);
        } catch (e) {
          logError(
            "gmail.filter_rule.archive_past_failed",
            { account_id: data.account_id, folder_id: data.to_folder_id },
            e,
          );
        }
      }
      await Promise.all(
        targetRows.map((row) =>
          supabaseAdmin
            .from("emails")
            .update({
              is_archived: true,
              raw_labels: removeLabelsFromCurrent(row.raw_labels, ["INBOX"]),
            })
            .eq("id", row.id),
        ),
      );
      archived = targetRows.length;
    }

    return { moved, failed, archived };
  });

/**
 * Retroactively apply a folder's behavior toggle to emails already classified into it.
 * Called when the user flips auto_mark_read, auto_archive/hide_from_inbox, or auto_star ON.
 * Updates Zerrow DB + Gmail (via batchModify) in one pass. Capped at 10k emails per call.
 */
export const applyFolderBehaviorRetroactive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        folderId: z.string().uuid(),
        behavior: z.enum(["mark_read", "archive", "star"]),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const userId = context.userId;
    const { data: folder, error: fErr } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, gmail_account_id")
      .eq("id", data.folderId)
      .single();
    if (fErr || !folder) throw new Error("Folder not found");
    if (folder.user_id !== userId) throw new Error("Not authorized");

    // Pick rows that still need the change.
    let query = supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, raw_labels")
      .eq("folder_id", data.folderId)
      .eq("user_id", userId)
      .limit(10000);
    if (data.behavior === "mark_read") query = query.eq("is_read", false);
    else if (data.behavior === "archive") query = query.eq("is_archived", false);
    // For "star" we can't tell from DB (no column) — let Gmail dedupe; just touch all rows.

    const { data: rows, error: eErr } = await query;
    if (eErr) throw new Error(eErr.message);
    if (!rows || rows.length === 0) return { count: 0 };

    const ids = rows.map((r) => r.gmail_message_id).filter(Boolean) as string[];

    // Gmail side — fire and forget the per-chunk errors so partial success still updates DB.
    try {
      if (data.behavior === "mark_read") {
        await batchModifyMessages(folder.gmail_account_id, ids, [], ["UNREAD"]);
      } else if (data.behavior === "archive") {
        await batchModifyMessages(folder.gmail_account_id, ids, [], ["INBOX"]);
      } else if (data.behavior === "star") {
        await batchModifyMessages(folder.gmail_account_id, ids, ["STARRED"], []);
      }
    } catch (e) {
      logError(
        "gmail.retroactive.batch_modify_failed",
        { account_id: folder.gmail_account_id, folder_id: data.folderId },
        e,
      );
    }

    // DB side.
    const patch: { is_read?: boolean; is_archived?: boolean; raw_labels?: string[] } = {};
    if (data.behavior === "mark_read") patch.is_read = true;
    else if (data.behavior === "archive") patch.is_archived = true;
    if (Object.keys(patch).length > 0) {
      if (data.behavior === "archive") {
        await Promise.all(
          rows.map((row) =>
            supabaseAdmin
              .from("emails")
              .update({ ...patch, raw_labels: removeLabelsFromCurrent(row.raw_labels, ["INBOX"]) })
              .eq("id", row.id),
          ),
        );
      } else {
        await supabaseAdmin
          .from("emails")
          .update(patch)
          .in(
            "id",
            rows.map((r) => r.id),
          );
      }
    }

    return { count: rows.length };
  });

// ─── Bulk actions on the "No rules" view ────────────────────────────────────

export const listFolderEmailIds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    // Verify the folder belongs to the caller before listing its emails.
    const { data: folder, error: folderError } = await supabaseAdmin
      .from("folders")
      .select("id")
      .eq("id", data.folder_id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (folderError) throw folderError;
    if (!folder) return { ids: [] as string[] };

    const { data: rows, error } = await supabaseAdmin
      .from("emails")
      .select("id")
      .eq("folder_id", data.folder_id)
      .eq("user_id", context.userId);
    if (error) throw error;

    return { ids: (rows ?? []).map((r) => r.id as string) };
  });

export const reclassifyEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_ids: string[] }) =>
    z.object({ email_ids: z.array(z.string().uuid()).min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { classifyParsedEmail } = await import("../sync.server");
    const { rows } = await getEmailsDecrypted(data.email_ids);
    if (rows.length === 0) return { routed: 0, unchanged: 0, failed: 0 };

    let routed = 0;
    let unchanged = 0;
    let failed = 0;

    for (const email of rows) {
      if (email.user_id !== context.userId) {
        failed++;
        continue;
      }
      if (!email.id || !email.gmail_account_id) {
        failed++;
        continue;
      }
      try {
        const parsed = {
          from_addr: email.from_addr ?? "",
          from_name: email.from_name ?? "",
          to_addrs: email.to_addrs ?? "",
          subject: email.subject ?? "",
          snippet: email.snippet ?? "",
          body_text: email.body_text ?? "",
          body_html: email.body_html ?? "",
          has_attachment: !!email.has_attachment,
          received_at: email.received_at ?? new Date().toISOString(),
          raw_labels: (email.raw_labels as string[] | null) ?? null,
        };
        const result = await classifyParsedEmail(parsed, context.userId, email.gmail_account_id, {
          skipGmailLabelMatch: true,
        });
        const isSurfaced = result.classified_by === "surfaced_to_inbox";
        if (result.folder_id && (result.folder_id !== email.folder_id || isSurfaced)) {
          await updateEmailEncrypted({
            email_id: email.id,
            classification_reason: result.classification_reason ?? "",
          });
          await supabaseAdmin
            .from("emails")
            .update({
              folder_id: result.folder_id,
              classified_by: result.classified_by,
              ai_confidence: result.ai_confidence,
              matched_filter_ids: result.matched_filter_ids,
              surfaced_to_inbox: isSurfaced,
              // A surfaced email is filed but kept visible in the inbox.
              ...(isSurfaced ? { is_archived: false, snoozed_until: null } : {}),
            })
            .eq("id", email.id);
          // Surfaced mail must carry both its folder label AND INBOX.
          if (isSurfaced && email.gmail_message_id) {
            const { data: sf } = await supabaseAdmin
              .from("folders")
              .select("gmail_label_id")
              .eq("id", result.folder_id)
              .maybeSingle();
            const addLabels = ["INBOX", ...(sf?.gmail_label_id ? [sf.gmail_label_id] : [])];
            try {
              await modifyMessage(email.gmail_account_id, email.gmail_message_id, addLabels, []);
            } catch (e) {
              logError(
                "gmail.reclassify.surface_label_failed",
                { email_id: email.id, user_id: context.userId },
                e,
              );
            }
          }
          routed++;
        } else if (!result.folder_id && email.folder_id && result.classified_by !== "ai_error") {
          // The email no longer belongs in its current folder — an always-inbox
          // override now wins, a deterministic exclude / allowlist rule vetoes
          // the folder, or the classifier no longer assigns any folder. Restore
          // it to the inbox (same steps as the manual "Move to Inbox" action) so
          // it shows up in the inbox view, which filters on the INBOX label +
          // is_archived = false. Transient ai_error is skipped so a failed AI
          // call never yanks a correctly-filed email.
          const { data: f } = await supabaseAdmin
            .from("folders")
            .select("gmail_label_id")
            .eq("id", email.folder_id)
            .maybeSingle();
          const fromLabel = f?.gmail_label_id ?? null;

          await restoreEmailToInbox({
            emailId: email.id,
            gmailAccountId: email.gmail_account_id,
            gmailMessageId: email.gmail_message_id,
            currentLabels: ((email.raw_labels as string[] | null) ?? []) as string[],
            fromLabel,
            classifiedBy: result.classified_by,
            classificationReason: result.classification_reason ?? "",
            aiConfidence: result.ai_confidence,
            labelFailureLog: {
              event: "gmail.reclassify.inbox_restore_label_failed",
              payload: { email_id: email.id, user_id: context.userId },
            },
          });
          routed++;
        } else {
          unchanged++;
        }
      } catch (e) {
        logError(
          "gmail.reclassify.iter_failed",
          { email_id: email.id, user_id: context.userId },
          e,
        );
        failed++;
      }
    }
    return { routed, unchanged, failed };
  });

export const suggestFolderFromSelection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_ids: string[] }) =>
    z.object({ email_ids: z.array(z.string().uuid()).min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: rows } = await supabaseAdmin
      .from("emails")
      .select("user_id, from_addr")
      .in("id", data.email_ids)
      .limit(50);
    const safe = (rows ?? []).filter((r) => r.user_id === context.userId);
    if (safe.length === 0) throw new Error("No emails found");
    const suggestion = await suggestFolderFromEmails(
      safe.map((r) => ({
        from_addr: r.from_addr,
        from_name: null,
        subject: null,
        snippet: null,
      })),
    );
    return suggestion;
  });

export const createFolderAndAssign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      account_id: string;
      name: string;
      color: string;
      ai_rule: string;
      filter?: { field: string; op: string; value: string } | null;
      email_ids: string[];
    }) =>
      z
        .object({
          account_id: z.string().uuid(),
          name: z.string().min(1).max(80),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
          ai_rule: z.string().max(500),
          filter: z
            .object({
              field: z.string().min(1).max(40),
              op: z.string().min(1).max(20),
              value: z.string().min(1).max(200),
            })
            .nullable()
            .optional(),
          email_ids: z.array(z.string().uuid()).max(100),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const { data: folder, error } = await supabaseAdmin
      .from("folders")
      .insert({
        user_id: context.userId,
        gmail_account_id: data.account_id,
        name: data.name,
        color: data.color,
        ai_rule: data.ai_rule,
      })
      .select("id")
      .single();
    if (error || !folder) throw new Error(error?.message ?? "Could not create folder");

    if (data.filter) {
      await supabaseAdmin.from("folder_filters").insert({
        folder_id: folder.id,
        field: data.filter.field,
        op: data.filter.op,
        value: data.filter.value,
      });
    }

    if (data.email_ids.length > 0) {
      await Promise.all(
        data.email_ids.map((id) =>
          updateEmailEncrypted({
            email_id: id,
            classification_reason: `Moved into new folder "${data.name}"`,
          }),
        ),
      );
      await supabaseAdmin
        .from("emails")
        .update({
          folder_id: folder.id,
          classified_by: "manual_move",
          ai_confidence: 1,
        })
        .eq("user_id", context.userId)
        .in("id", data.email_ids);
    }

    invalidateAccountContext(data.account_id);
    return { folder_id: folder.id };
  });

export const setFolderAutoRelearn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; auto_relearn: boolean; threshold?: number }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        auto_relearn: z.boolean(),
        threshold: z.number().int().min(1).max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: { auto_relearn: boolean; relearn_threshold?: number } = {
      auto_relearn: data.auto_relearn,
    };
    if (data.threshold !== undefined) patch.relearn_threshold = data.threshold;
    const { error } = await supabaseAdmin
      .from("folders")
      .update(patch)
      .eq("id", data.folder_id)
      .eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Scan Gmail for messages matching this folder's existing rules and ingest
// any that aren't already in the local DB. Translates folder_filters (and any
// filter_tree leaves) into Gmail query strings; messages land via the usual
// matchFilters path so they get classified into this folder on insert.
export const scanGmailForFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; months?: 1 | 3 | 6 | 12 }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const months = data.months ?? 6;

    // Load folder + verify ownership.
    const { data: folder, error: fErr } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, gmail_account_id, name, filter_tree")
      .eq("id", data.folder_id)
      .maybeSingle();
    if (fErr || !folder) throw new Error("Folder not found");
    if (folder.user_id !== context.userId) throw new Error("Not authorized for this folder");
    const accountId = folder.gmail_account_id;
    const folderName = folder.name;

    // Build Gmail search queries respecting AND/OR groups (filter_tree is
    // authoritative when present, otherwise fall back to flat folder_filters).
    const { data: ff } = await supabaseAdmin
      .from("folder_filters")
      .select("field, op, value")
      .eq("folder_id", folder.id);
    const flatForThisFolder = (ff ?? []) as Array<{ field: string; op: string; value: string }>;
    const { queries: queryList, skippedRegex } = buildGmailQueries(
      { filter_tree: folder.filter_tree as RuleNode | null, filters: flatForThisFolder },
      { suffix: ` newer_than:${months}m`, maxQueries: 20 },
    );
    const queries = new Set(queryList);

    if (queries.size === 0) {
      return {
        ok: false as const,
        ingested: 0,
        found: 0,
        queries_run: 0,
        skipped_regex: skippedRegex,
        truncated: false,
        reason: "no_translatable_rules" as const,
      };
    }

    // Folder-rule cache for the shared filter engine (so messages get
    // classified into the right folder using the same AND/OR/priority logic
    // as the live sync pipeline).
    const { data: foldersRaw } = await supabaseAdmin
      .from("folders")
      .select("*")
      .eq("user_id", context.userId)
      .eq("gmail_account_id", accountId);
    const allFolders = (foldersRaw ?? []) as Folder[];
    const labelToFolder = new Map<string, string>();
    for (const f of allFolders) {
      if (f.gmail_label_id) labelToFolder.set(f.gmail_label_id, f.id);
    }
    const folderIds = allFolders.map((f) => f.id);
    let allFilters: Filter[] = [];
    if (folderIds.length > 0) {
      const { data: allFF } = await supabaseAdmin
        .from("folder_filters")
        .select("id, folder_id, field, op, value")
        .in("folder_id", folderIds);
      allFilters = (allFF ?? []) as Filter[];
    }

    const HARD_INGEST_CAP = 1000;
    const PAGE = 100;
    const MAX_PAGES = 5;

    let totalFound = 0;
    let totalIngested = 0;
    let truncated = false;
    let queriesRun = 0;
    let reauthFailed = false;

    outer: for (const q of queries) {
      queriesRun++;
      try {
        // Page through results for this query.
        const hits: Array<{ id: string; threadId: string }> = [];
        let pageToken: string | undefined;
        for (let p = 0; p < MAX_PAGES; p++) {
          const list = await listMessages(accountId, { q, maxResults: PAGE, pageToken });
          for (const m of list.messages ?? []) hits.push(m);
          pageToken = list.nextPageToken;
          if (!pageToken) break;
        }
        if (hits.length === 0) continue;

        const ids = Array.from(new Set(hits.map((m) => m.id)));
        totalFound += ids.length;

        // Skip ones already in the DB.
        const { data: existing } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("user_id", context.userId)
          .in("gmail_message_id", ids);
        const known = new Set((existing ?? []).map((r) => r.gmail_message_id));
        const todo = ids.filter((id) => !known.has(id));

        const CONCURRENCY = 8;
        let i = 0;
        async function worker() {
          while (i < todo.length) {
            if (totalIngested >= HARD_INGEST_CAP) {
              truncated = true;
              return;
            }
            const id = todo[i++];
            try {
              const raw = await getMessage(accountId, id);
              const p = parseMessage(raw);
              let folder_id: string | null = null;
              let classified_by: string = "gmail_search_ingest";
              let classification_reason: string | null = `Scanned for folder: ${folderName}`;
              let matched_filter_ids: string[] = [];
              for (const lbl of p.raw_labels ?? []) {
                const fid = labelToFolder.get(lbl);
                if (fid) {
                  folder_id = fid;
                  classified_by = "gmail_label";
                  classification_reason = "Matched Gmail label";
                  break;
                }
              }
              if (!folder_id) {
                const result = matchByFilters(
                  {
                    from_addr: p.from_addr ?? "",
                    from_name: p.from_name ?? "",
                    to_addrs: p.to_addrs ?? "",
                    subject: p.subject ?? "",
                    body_text: p.body_text ?? "",
                    has_attachment: !!p.has_attachment,
                  },
                  allFolders,
                  allFilters,
                );
                if (result?.kind === "match") {
                  folder_id = result.folder_id;
                  matched_filter_ids = result.matched_filters.map((f) => f.id);
                  if (result.tree_used) {
                    classified_by = "filter";
                    classification_reason = `Rule group matched for "${allFolders.find((f) => f.id === result.folder_id)?.name ?? folderName}"`;
                  } else if (result.filter) {
                    classified_by = result.filter.field === "domain" ? "domain_rule" : "filter";
                    classification_reason =
                      result.filter.field === "domain"
                        ? `Domain rule: ${result.filter.value}`
                        : `Folder rule: ${result.filter.field} ${result.filter.value}`;
                  } else {
                    classified_by = "filter";
                    classification_reason = "Folder rule matched";
                  }
                }
              }
              const { id: newId, error } = await upsertEmailEncrypted({
                user_id: context.userId,
                gmail_account_id: accountId,
                gmail_message_id: p.gmail_message_id,
                thread_id: p.thread_id,
                from_addr: p.from_addr,
                from_name: p.from_name,
                to_addrs: p.to_addrs,
                cc: null,
                list_id: null,
                in_reply_to: null,
                subject: p.subject,
                snippet: p.snippet,
                body_text: p.body_text,
                body_html: p.body_html,
                received_at: p.received_at,
                is_read: p.is_read,
                is_archived: !(p.raw_labels ?? []).includes("INBOX"),
                has_attachment: p.has_attachment,
                raw_labels: p.raw_labels,
                classified_by: classified_by ?? "pending",
                processed_at: null,
                published_at_ms: null,
              });

              if (!error) {
                totalIngested++;
                if (newId && folder_id) {
                  await updateEmailEncrypted({
                    email_id: newId,
                    folder_id,
                    ai_confidence: 1,
                    classification_reason,
                    matched_filter_ids,
                  });
                }
              } else
                logError(
                  "gmail.scan_folder.insert_failed",
                  { account_id: accountId, gmail_message_id: id },
                  { message: error },
                );
            } catch (e) {
              logError(
                "gmail.scan_folder.one_failed",
                { account_id: accountId, gmail_message_id: id },
                e,
              );
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
        if (totalIngested >= HARD_INGEST_CAP) {
          truncated = true;
          break outer;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/missing OAuth tokens|reauthorize|invalid_grant/i.test(msg)) {
          reauthFailed = true;
          break;
        }
        logError(
          "gmail.scan_folder.query_failed",
          { account_id: accountId, folder_id: folder.id, q },
          e,
        );
      }
    }

    if (reauthFailed && totalIngested === 0) {
      return {
        ok: false as const,
        ingested: 0,
        found: totalFound,
        queries_run: queriesRun,
        skipped_regex: skippedRegex,
        truncated: false,
        reason: "reauth_required" as const,
      };
    }

    return {
      ok: true as const,
      ingested: totalIngested,
      found: totalFound,
      queries_run: queriesRun,
      skipped_regex: skippedRegex,
      truncated,
    };
  });
