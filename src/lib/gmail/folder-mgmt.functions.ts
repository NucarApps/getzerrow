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
export const listFolderHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; limit?: number; offset?: number }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        limit: z.number().min(1).max(200).optional(),
        offset: z.number().min(0).max(10000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id")
      .eq("id", data.folder_id)
      .single();
    if (!folder || folder.user_id !== context.userId) throw new Error("Not authorized");
    const limit = data.limit ?? 25;
    const offset = data.offset ?? 0;
    const { data: rows } = await supabaseAdmin
      .from("emails")
      .select("id, from_addr, received_at, classified_by, ai_confidence")
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id)
      .order("received_at", { ascending: false })
      .range(offset, offset + limit); // fetch one extra to detect has_more
    const baseRows = rows ?? [];
    type Row = {
      id: string;
      subject: string | null;
      from_addr: string | null;
      from_name: string | null;
      received_at: string | null;
      classified_by: string | null;
      ai_confidence: number | null;
      snippet: string | null;
      ai_summary: string | null;
    };
    let withSummary: Row[] = (baseRows as unknown[]).map((r) => ({
      ...(r as object),
      subject: null,
      from_name: null,
      snippet: null,
      ai_summary: null,
    })) as Row[];
    if (baseRows.length > 0) {
      const { data: dec } = await supabaseAdmin.rpc("get_emails_list_fields_decrypted", {
        p_ids: baseRows.map((r) => r.id),
        p_key: process.env.EMAIL_ENC_KEY!,
      });
      const map = new Map<string, string | null>();
      for (const d of (dec as Array<{ id: string; ai_summary: string | null }> | null) ?? []) {
        map.set(d.id, d.ai_summary);
      }
      withSummary = withSummary.map((r) => ({ ...r, ai_summary: map.get(r.id) ?? null }));
    }
    const has_more = withSummary.length > limit;
    return {
      emails: has_more ? withSummary.slice(0, limit) : withSummary,
      has_more,
      next_offset: offset + limit,
    };
  });

// Accuracy/health snapshot for a single folder: how mail landed here (rules
// vs AI vs manual), low-confidence volume, and learning status. Read-only,
// aggregated from existing columns — no schema changes.
export const getFolderHealth = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select(
        "id, user_id, emails_since_learn, last_learned_at, learned_profile, relearn_threshold, auto_relearn",
      )
      .eq("id", data.folder_id)
      .single();
    if (!folder || folder.user_id !== context.userId) throw new Error("Not authorized");

    const { count: total } = await supabaseAdmin
      .from("emails")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id);

    // Sample the most recent rows for the breakdown so this stays bounded on
    // large folders.
    const { data: rows } = await supabaseAdmin
      .from("emails")
      .select("classified_by, ai_confidence")
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id)
      .order("received_at", { ascending: false })
      .limit(1000);

    const sample = rows ?? [];
    let byRules = 0;
    let byAi = 0;
    let byManual = 0;
    let other = 0;
    let lowConfidence = 0;
    let confSum = 0;
    let confCount = 0;
    for (const r of sample) {
      const cb = r.classified_by ?? "";
      if (cb === "manual_move" || cb === "manual_inbox") {
        byManual++;
      } else if (cb.startsWith("ai")) {
        byAi++;
        if (typeof r.ai_confidence === "number") {
          confSum += r.ai_confidence;
          confCount++;
        }
        if (
          cb === "ai_low_confidence" ||
          (typeof r.ai_confidence === "number" && r.ai_confidence < 0.6)
        ) {
          lowConfidence++;
        }
      } else if (cb === "filter" || cb === "domain_rule" || cb === "override" || cb === "label") {
        byRules++;
      } else {
        other++;
      }
    }

    const { count: exampleCount } = await supabaseAdmin
      .from("folder_examples")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id);

    const { data: recentEx } = await supabaseAdmin
      .from("folder_examples")
      .select("created_at")
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id)
      .eq("source", "manual_move")
      .order("created_at", { ascending: false })
      .limit(50);

    return {
      total: total ?? 0,
      sampled: sample.length,
      byRules,
      byAi,
      byManual,
      other,
      lowConfidence,
      avgConfidence: confCount > 0 ? confSum / confCount : null,
      learning: {
        examples: exampleCount ?? 0,
        recentCorrections: (recentEx ?? []).length,
        lastCorrectionAt: (recentEx ?? [])[0]?.created_at ?? null,
        lastLearnedAt: folder.last_learned_at,
        hasProfile: !!folder.learned_profile,
        emailsSinceLearn: folder.emails_since_learn,
        relearnThreshold: folder.relearn_threshold,
        autoRelearn: folder.auto_relearn,
      },
    };
  });

// Rebuild a folder's learned profile on demand from its collected examples.
export const relearnFolderNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id")
      .eq("id", data.folder_id)
      .single();
    if (!folder || folder.user_id !== context.userId) throw new Error("Not authorized");
    const { regenerateFolderProfile } = await import("../sync/folder-learn");
    const profile = await regenerateFolderProfile(data.folder_id);
    return { ok: true, hasProfile: !!profile };
  });

export const suggestRecategorization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_id: string; to_folder_id: string }) =>
    z.object({ email_id: z.string().uuid(), to_folder_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { rows } = await getEmailsDecrypted([data.email_id]);
    const email = rows[0];
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");
    if (!email.folder_id) throw new Error("Email has no source folder");
    if (email.folder_id === data.to_folder_id)
      throw new Error("Source and target folders must differ");

    const { data: folders } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name, ai_rule, learned_profile")
      .in("id", [email.folder_id, data.to_folder_id]);
    const source = folders?.find((f) => f.id === email.folder_id);
    const target = folders?.find((f) => f.id === data.to_folder_id);
    if (
      !source ||
      !target ||
      source.user_id !== context.userId ||
      target.user_id !== context.userId
    ) {
      throw new Error("Not authorized");
    }

    try {
      const sug = await suggestRuleUpdates({
        email: {
          from_addr: email.from_addr || "",
          from_name: email.from_name || "",
          subject: email.subject || "",
          snippet: email.snippet || "",
          body_text: email.body_text || "",
        },
        source: {
          name: source.name,
          ai_rule: source.ai_rule,
          learned_profile: source.learned_profile,
        },
        target: {
          name: target.name,
          ai_rule: target.ai_rule,
          learned_profile: target.learned_profile,
        },
      });
      return {
        source: {
          id: source.id,
          name: source.name,
          current_rule: source.ai_rule,
          current_profile: source.learned_profile,
          ...sug.source,
        },
        target: {
          id: target.id,
          name: target.name,
          current_rule: target.ai_rule,
          current_profile: target.learned_profile,
          ...sug.target,
        },
        error: null as string | null,
      };
    } catch (e: unknown) {
      logError("gmail.suggest_recat.ai_failed", { user_id: context.userId }, e);
      return {
        source: {
          id: source.id,
          name: source.name,
          current_rule: source.ai_rule,
          current_profile: source.learned_profile,
          proposed_rule: source.ai_rule ?? "",
          proposed_profile: source.learned_profile ?? "",
          why: "AI suggestion unavailable — you can still apply the move.",
        },
        target: {
          id: target.id,
          name: target.name,
          current_rule: target.ai_rule,
          current_profile: target.learned_profile,
          proposed_rule: target.ai_rule ?? "",
          proposed_profile: target.learned_profile ?? "",
          why: "AI suggestion unavailable — you can still apply the move.",
        },
        error: e instanceof Error ? e.message : "AI request failed",
      };
    }
  });

export const applyRecategorization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      email_id: string;
      to_folder_id: string;
      apply_source: boolean;
      apply_target: boolean;
      source_rule?: string | null;
      source_profile?: string | null;
      target_rule?: string | null;
      target_profile?: string | null;
    }) =>
      z
        .object({
          email_id: z.string().uuid(),
          to_folder_id: z.string().uuid(),
          apply_source: z.boolean(),
          apply_target: z.boolean(),
          source_rule: z.string().max(10000).nullable().optional(),
          source_profile: z.string().max(10000).nullable().optional(),
          target_rule: z.string().max(10000).nullable().optional(),
          target_profile: z.string().max(10000).nullable().optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select("id, user_id, folder_id, gmail_message_id, gmail_account_id, from_addr")
      .eq("id", data.email_id)
      .single();
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");
    if (!email.folder_id) throw new Error("Email has no source folder");
    const fromFolderId = email.folder_id;
    if (fromFolderId === data.to_folder_id)
      throw new Error("Source and target folders must differ");

    const { data: folders } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name, gmail_label_id")
      .in("id", [fromFolderId, data.to_folder_id]);
    const from = folders?.find((f) => f.id === fromFolderId);
    const to = folders?.find((f) => f.id === data.to_folder_id);
    if (!from || !to || from.user_id !== context.userId || to.user_id !== context.userId) {
      throw new Error("Not authorized");
    }

    // Move the email
    await updateEmailEncrypted({
      email_id: email.id,
      folder_id: data.to_folder_id,
      classified_by: "manual_move",
      ai_confidence: 1,
      classification_reason: `Re-categorized from "${from.name}" to "${to.name}"`,
    });
    await supabaseAdmin
      .from("emails")
      .update({ folder_id: data.to_folder_id, classified_by: "manual_move", ai_confidence: 1 })
      .eq("id", email.id);

    // Best-effort Gmail label sync
    if (from.gmail_label_id || to.gmail_label_id) {
      try {
        await modifyMessage(
          email.gmail_account_id,
          email.gmail_message_id,
          to.gmail_label_id ? [to.gmail_label_id] : [],
          from.gmail_label_id ? [from.gmail_label_id] : [],
        );
      } catch (e) {
        logError("gmail.label_sync.failed", {}, e);
      }
    }

    // Move example from source → target so AI signal reflects the correction
    await supabaseAdmin
      .from("folder_examples")
      .delete()
      .eq("folder_id", fromFolderId)
      .eq("gmail_message_id", email.gmail_message_id);
    await insertFolderExampleEncrypted({
      folder_id: data.to_folder_id,
      user_id: context.userId,
      gmail_message_id: email.gmail_message_id,
      gmail_account_id: email.gmail_account_id,
      from_addr: email.from_addr,
      subject: null,
      snippet: null,
      source: "correction",
    });

    let source_updated = false;
    let target_updated = false;
    const now = new Date().toISOString();
    if (data.apply_source) {
      const patch: {
        last_learned_at: string;
        ai_rule?: string | null;
        learned_profile?: string | null;
      } = { last_learned_at: now };
      if (data.source_rule !== undefined) patch.ai_rule = data.source_rule;
      if (data.source_profile !== undefined) patch.learned_profile = data.source_profile;
      await supabaseAdmin.from("folders").update(patch).eq("id", fromFolderId);
      source_updated = true;
    }
    if (data.apply_target) {
      const patch: {
        last_learned_at: string;
        ai_rule?: string | null;
        learned_profile?: string | null;
      } = { last_learned_at: now };
      if (data.target_rule !== undefined) patch.ai_rule = data.target_rule;
      if (data.target_profile !== undefined) patch.learned_profile = data.target_profile;
      await supabaseAdmin.from("folders").update(patch).eq("id", data.to_folder_id);
      target_updated = true;
    }

    return { moved: 1, source_updated, target_updated };
  });

// ============ Folder summary schedules ============

export const listFolderSummaries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedFolder(context.userId, data.folder_id);
    const { data: rows } = await supabaseAdmin
      .from("folder_summary_schedules")
      .select(
        "id, name, instructions, hour, minute, timezone, enabled, last_run_at, next_run_at, last_error",
      )
      .eq("folder_id", data.folder_id)
      .order("created_at", { ascending: true });
    return { schedules: rows ?? [] };
  });

// Defaults for a newly created folder. A brand-new folder should do
// nothing rule- or AI-wise until the user gives it explicit intent
// (filter_tree or ai_rule) — regardless of whether it was linked to an
// existing Gmail label or created alongside a fresh one. Gmail-label
// routing still works because that's a Gmail-side signal, not a Zerrow
// classification. See folder-mgmt.defaults.test.ts.
export function deriveFolderAiDefaults(_gmailLabelId: string | null | undefined): {
  skip_ai: boolean;
  min_ai_confidence: number;
} {
  return { skip_ai: true, min_ai_confidence: 0.75 };
}

// Create a new folder owned by the authenticated user. Historically this was
// done via a direct `supabase.from("folders").insert(...)` from the browser,
// which silently failed after grants on public.folders were dropped. Doing
// the insert here with supabaseAdmin makes the write path consistent with
// the rest of the app and surfaces failures as server-function errors.
export const createFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      account_id: string;
      name: string;
      color?: string | null;
      gmail_label_id?: string | null;
    }) =>
      z
        .object({
          account_id: z.string().uuid(),
          name: z.string().trim().min(1).max(120),
          color: z
            .string()
            .regex(/^#[0-9a-fA-F]{6}$/)
            .nullish(),
          gmail_label_id: z.string().max(200).nullish(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    // Confirms the account belongs to the caller; throws otherwise.
    await getOwnedAccount(context.userId, data.account_id);
    // Safer defaults when the folder is linked to an existing Gmail label:
    // the user is asking to mirror what Gmail already sorted, not to invent
    // new AI matches. Unlinked folders keep the current AI-on default so
    // users who intend to define AI/filter rules aren't blocked.
    const { skip_ai: skipAiDefault, min_ai_confidence: minAiConfidenceDefault } =
      deriveFolderAiDefaults(data.gmail_label_id);
    const linkedLabel = !!data.gmail_label_id;
    const { data: row, error } = await supabaseAdmin
      .from("folders")
      .insert({
        user_id: context.userId,
        gmail_account_id: data.account_id,
        name: data.name,
        color: data.color ?? "#3b82f6",
        gmail_label_id: data.gmail_label_id ?? null,
        skip_ai: skipAiDefault,
        min_ai_confidence: minAiConfidenceDefault,
      })
      .select("id")
      .single();
    if (error || !row) {
      logError(
        "gmail.create_folder.insert_failed",
        { user_id: context.userId, account_id: data.account_id },
        error,
      );
      throw new Error(error?.message ?? "Failed to create folder");
    }
    logAudit("gmail.create_folder", {
      user_id: context.userId,
      account_id: data.account_id,
      folder_id: row.id,
      linked_label: linkedLabel,
      skip_ai_default: skipAiDefault,
      min_ai_confidence_default: minAiConfidenceDefault,
    });
    return { id: row.id };
  });

export const createFolderSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      folder_id: string;
      name: string;
      instructions: string;
      hour: number;
      minute: number;
      timezone: string;
    }) =>
      z
        .object({
          folder_id: z.string().uuid(),
          name: z.string().min(1).max(100),
          instructions: z.string().max(50000),
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
          timezone: ianaTz,
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const folder = await getOwnedFolder(context.userId, data.folder_id);
    const next = computeNextRun(data.hour, data.minute, data.timezone).toISOString();
    const { data: row, error } = await supabaseAdmin
      .from("folder_summary_schedules")
      .insert({
        user_id: context.userId,
        folder_id: data.folder_id,
        gmail_account_id: folder.gmail_account_id,
        name: data.name,
        instructions: data.instructions,
        hour: data.hour,
        minute: data.minute,
        timezone: data.timezone,
        next_run_at: next,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "Failed to create");
    return { id: row.id };
  });

export const updateFolderSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      id: string;
      name?: string;
      instructions?: string;
      hour?: number;
      minute?: number;
      timezone?: string;
      enabled?: boolean;
    }) =>
      z
        .object({
          id: z.string().uuid(),
          name: z.string().min(1).max(100).optional(),
          instructions: z.string().max(50000).optional(),
          hour: z.number().int().min(0).max(23).optional(),
          minute: z.number().int().min(0).max(59).optional(),
          timezone: ianaTz.optional(),
          enabled: z.boolean().optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const existing = await getOwnedSchedule(context.userId, data.id);
    const patch: {
      name?: string;
      instructions?: string;
      hour?: number;
      minute?: number;
      timezone?: string;
      enabled?: boolean;
      next_run_at?: string;
    } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.instructions !== undefined) patch.instructions = data.instructions;
    if (data.hour !== undefined) patch.hour = data.hour;
    if (data.minute !== undefined) patch.minute = data.minute;
    if (data.timezone !== undefined) patch.timezone = data.timezone;
    if (data.enabled !== undefined) patch.enabled = data.enabled;

    const timeChanged =
      data.hour !== undefined || data.minute !== undefined || data.timezone !== undefined;
    const reEnabled = data.enabled === true && !existing.enabled;
    if (timeChanged || reEnabled) {
      patch.next_run_at = computeNextRun(
        data.hour ?? existing.hour,
        data.minute ?? existing.minute,
        data.timezone ?? existing.timezone,
      ).toISOString();
    }
    const { error } = await supabaseAdmin
      .from("folder_summary_schedules")
      .update(patch)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteFolderSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedSchedule(context.userId, data.id);
    await supabaseAdmin.from("folder_summary_schedules").delete().eq("id", data.id);
    return { ok: true };
  });

export const runFolderSummaryNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedSchedule(context.userId, data.id);
    // Enqueue a background job so the UI request never has to wait on the
    // AI gateway (heavy prompts otherwise time out).
    const { jobId } = await enqueueFolderSummaryJob({
      scheduleId: data.id,
      userId: context.userId,
    });
    return { ok: true as const, jobId };
  });

export const getFolderSummaryJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: job, error } = await supabaseAdmin
      .from("folder_summary_jobs")
      .select("id, status, error, emails_count, created_at, started_at, finished_at")
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!job) throw new Error("Job not found");
    return { job };
  });

// Back-compat: keep the original synchronous entry point available for callers
// (e.g. the scheduled cron tick) that still want to run a schedule inline.
export const runFolderSummaryInline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedSchedule(context.userId, data.id);
    return runFolderSummary(data.id);
  });

// ============ Per-email move + similar ============
