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
} from "./gmail-helpers.server";
import { performMove } from "./move-email.server";
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
} from "./sync.server";
import { CATCHUP_MAX_ROUNDS, CATCHUP_TOTAL_BUDGET_MS } from "./sync/config";
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
} from "./gmail.server";
import {
  suggestReply,
  suggestRuleUpdates,
  suggestFolderFromEmails,
  generateAiRuleFromPurpose,
  generateAiRuleFromLabelSamples,
} from "./ai.server";
import { computeNextRun, enqueueFolderSummaryJob, runFolderSummary } from "./summaries.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signState, buildAuthorizeUrl, getRedirectUri } from "./google-oauth.server";
import { getRequestHost } from "@tanstack/react-start/server";
import { logError, logAudit } from "./log.server";
import { removeLabelsFromCurrent } from "./sync/label-merge";
import { buildGmailQueries } from "./sync/gmail-query-builder";
import { matchByFilters, emailVetoedForFolder } from "./sync/filter-engine";
import type { Folder, Filter, RuleNode } from "./sync/types";
import {
  upsertEmailEncrypted,
  updateEmailEncrypted,
  setReplyDraftEncrypted,
  insertFolderExampleEncrypted,
} from "./sync/encrypted-writer";
import { getEmailsDecrypted } from "./sync/encrypted-reader";
export const loadOlderFromGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; before_received_at: string | null }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        before_received_at: z.string().datetime({ offset: true }).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    return loadOlderFromLabel(data.folder_id, context.userId, data.before_received_at);
  });

export const listFolderDomainSuggestions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id")
      .eq("id", data.folder_id)
      .single();
    if (!folder || folder.user_id !== context.userId) throw new Error("Not authorized");

    const [{ data: examples }, { data: existingFilters }] = await Promise.all([
      supabaseAdmin.from("folder_examples").select("from_addr").eq("folder_id", data.folder_id),
      supabaseAdmin
        .from("folder_filters")
        .select("value")
        .eq("folder_id", data.folder_id)
        .eq("field", "domain")
        .eq("op", "contains"),
    ]);

    const taken = new Set((existingFilters ?? []).map((f) => f.value.toLowerCase()));
    const counts = new Map<string, number>();
    for (const e of examples ?? []) {
      const addr = (e.from_addr || "").toLowerCase().trim();
      const at = addr.lastIndexOf("@");
      if (at === -1) continue;
      const domain = addr.slice(at + 1).replace(/[>\s].*$/, "");
      if (!domain || taken.has(domain)) continue;
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    const suggestions = [...counts.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);
    return { suggestions };
  });

export const addDomainFilter = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; domain: string }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        domain: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-z0-9.-]+$/i),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, gmail_account_id")
      .eq("id", data.folder_id)
      .single();
    if (!folder || folder.user_id !== context.userId) throw new Error("Not authorized");
    const { error } = await supabaseAdmin.from("folder_filters").insert({
      folder_id: data.folder_id,
      field: "domain",
      op: "contains",
      value: data.domain.toLowerCase(),
    });
    if (error) throw new Error(error.message);
    invalidateAccountContext(folder.gmail_account_id);
    return { ok: true };
  });

export const reassignDomainToFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { from_folder_id: string; to_folder_id: string; domain: string }) =>
    z
      .object({
        from_folder_id: z.string().uuid(),
        to_folder_id: z.string().uuid(),
        domain: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-z0-9.-]+$/i),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.from_folder_id === data.to_folder_id) throw new Error("Folders must differ");
    const { data: folders } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name, gmail_label_id, gmail_account_id")
      .in("id", [data.from_folder_id, data.to_folder_id]);
    const from = folders?.find((f) => f.id === data.from_folder_id);
    const to = folders?.find((f) => f.id === data.to_folder_id);
    if (!from || !to || from.user_id !== context.userId || to.user_id !== context.userId) {
      throw new Error("Not authorized");
    }
    const domain = data.domain.toLowerCase();

    // Add domain filter on destination if not already there
    const { data: existing } = await supabaseAdmin
      .from("folder_filters")
      .select("id")
      .eq("folder_id", data.to_folder_id)
      .eq("field", "domain")
      .eq("op", "contains")
      .eq("value", domain)
      .maybeSingle();
    if (!existing) {
      await supabaseAdmin.from("folder_filters").insert({
        folder_id: data.to_folder_id,
        field: "domain",
        op: "contains",
        value: domain,
      });
    }

    // Find emails in the source folder matching this domain
    const { data: matches } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, gmail_account_id")
      .eq("user_id", context.userId)
      .eq("folder_id", data.from_folder_id)
      .ilike("from_addr", `%@${domain}%`);

    const ids = (matches ?? []).map((m) => m.id);

    if (ids.length > 0) {
      const classReason = `Domain rule: ${domain} → ${to.name}`;
      const { error: upErr } = await supabaseAdmin
        .from("emails")
        .update({
          folder_id: data.to_folder_id,
          classified_by: "domain_rule",
          ai_confidence: 1,
        })
        .in("id", ids);
      if (upErr) throw new Error(upErr.message);
      await Promise.all(
        ids.map((id) => updateEmailEncrypted({ email_id: id, classification_reason: classReason })),
      );

      // Best-effort Gmail label sync
      if (from.gmail_label_id || to.gmail_label_id) {
        const addLabels = to.gmail_label_id ? [to.gmail_label_id] : [];
        const removeLabels = from.gmail_label_id ? [from.gmail_label_id] : [];
        await Promise.all(
          (matches ?? []).map(async (m) => {
            try {
              await modifyMessage(m.gmail_account_id, m.gmail_message_id, addLabels, removeLabels);
            } catch (e) {
              logError(
                "gmail.reassign.label_modify_failed",
                { account_id: m.gmail_account_id, gmail_message_id: m.gmail_message_id },
                e,
              );
            }
          }),
        );
      }
    }

    // Remove source folder examples for this domain so the suggestion stops reappearing
    const { data: srcExamples } = await supabaseAdmin
      .from("folder_examples")
      .select("id, from_addr, gmail_message_id, gmail_account_id")
      .eq("folder_id", data.from_folder_id)
      .ilike("from_addr", `%@${domain}%`);

    const srcExampleIds = (srcExamples ?? []).map((e) => e.id);
    if (srcExampleIds.length > 0) {
      await supabaseAdmin.from("folder_examples").delete().in("id", srcExampleIds);

      // Mirror examples onto destination folder so its learned signal reflects the move
      const mirrored = (srcExamples ?? []).map((e) => ({
        folder_id: data.to_folder_id,
        user_id: context.userId,
        gmail_message_id: e.gmail_message_id,
        from_addr: e.from_addr,
        subject: null,
        snippet: null,
        gmail_account_id: e.gmail_account_id,
        source: "reassigned",
      }));
      for (const m of mirrored) {
        await insertFolderExampleEncrypted({
          folder_id: m.folder_id,
          user_id: m.user_id,
          gmail_account_id: m.gmail_account_id,
          gmail_message_id: m.gmail_message_id,
          from_addr: m.from_addr ?? null,
          subject: m.subject ?? null,
          snippet: m.snippet ?? null,
          source: m.source,
        });
      }
    }

    return { moved: ids.length };
  });

