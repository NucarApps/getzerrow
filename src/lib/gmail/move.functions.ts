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
export const moveEmailToFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_id: string; to_folder_id: string }) =>
    z
      .object({
        email_id: z.string().uuid(),
        to_folder_id: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select("from_addr, folder_id, user_id")
      .eq("id", data.email_id)
      .single();
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");
    const fromFolderId = email.folder_id;

    const result = await performMove(context.userId, data.email_id, data.to_folder_id);
    if (!result.ok) throw new Error(result.error);

    return {
      ok: true,
      from_folder_id: fromFolderId,
      from_addr: email.from_addr,
      domain: extractDomain(email.from_addr),
    };
  });

export const findSimilarEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: { email_id: string; from_folder_id: string | null; mode: "sender" | "domain" }) =>
      z
        .object({
          email_id: z.string().uuid(),
          from_folder_id: z.string().uuid().nullable(),
          mode: z.enum(["sender", "domain"]),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select("id, user_id, from_addr")
      .eq("id", data.email_id)
      .single();
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");

    let query = supabaseAdmin
      .from("emails")
      .select("id, from_addr, received_at")
      .eq("user_id", context.userId)
      .neq("id", data.email_id)
      .order("received_at", { ascending: false })
      .limit(50);

    if (data.from_folder_id) query = query.eq("folder_id", data.from_folder_id);
    else query = query.is("folder_id", null);

    if (data.mode === "sender") {
      if (!email.from_addr) return { matches: [], domain: null };
      query = query.eq("from_addr", email.from_addr);
    } else {
      const domain = extractDomain(email.from_addr);
      if (!domain) return { matches: [], domain: null };
      query = query.ilike("from_addr", `%@${domain}%`);
    }
    const { data: rows } = await query;
    return {
      matches: (rows ?? []).map((r) => ({
        id: r.id,
        from_addr: r.from_addr,
        received_at: r.received_at,
        subject: null,
        from_name: null,
        snippet: null,
      })) as Array<{
        id: string;
        subject: string | null;
        from_addr: string | null;
        from_name: string | null;
        received_at: string | null;
        snippet: string | null;
      }>,
      domain: extractDomain(email.from_addr),
    };
  });

export const bulkMoveEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      email_ids: string[];
      to_folder_id: string;
      create_rule?: { field: "domain" | "from"; value: string } | null;
    }) =>
      z
        .object({
          email_ids: z.array(z.string().uuid()).min(1).max(100),
          to_folder_id: z.string().uuid(),
          create_rule: z
            .object({
              field: z.enum(["domain", "from"]),
              value: z.string().min(1).max(253),
            })
            .nullable()
            .optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    // If asked, persist a folder rule on the destination so future mail
    // auto-routes. Verify ownership of the destination folder first.
    let ruleReason: string | undefined;
    if (data.create_rule) {
      const { data: folder } = await supabaseAdmin
        .from("folders")
        .select("id, user_id, name")
        .eq("id", data.to_folder_id)
        .single();
      if (!folder || folder.user_id !== context.userId) {
        throw new Error("Target folder not found");
      }
      const value = data.create_rule.value.toLowerCase();
      const field = data.create_rule.field;
      const { data: existing } = await supabaseAdmin
        .from("folder_filters")
        .select("id")
        .eq("folder_id", data.to_folder_id)
        .eq("field", field)
        .eq("op", "contains")
        .eq("value", value)
        .maybeSingle();
      if (!existing) {
        await supabaseAdmin.from("folder_filters").insert({
          folder_id: data.to_folder_id,
          field,
          op: "contains",
          value,
        });
      }
      ruleReason =
        field === "domain"
          ? `Domain rule: ${value} → ${folder.name}`
          : `Sender rule: ${value} → ${folder.name}`;
    }

    let moved = 0;
    let failed = 0;
    for (const id of data.email_ids) {
      const r = await performMove(context.userId, id, data.to_folder_id, ruleReason);
      if (r.ok) moved++;
      else failed++;
    }
    // When the move came from a rule, retag the rows so audit/badge reflects it.
    if (data.create_rule && moved > 0) {
      const classifiedBy = data.create_rule.field === "domain" ? "domain_rule" : "filter";
      await supabaseAdmin
        .from("emails")
        .update({ classified_by: classifiedBy })
        .eq("user_id", context.userId)
        .in("id", data.email_ids)
        .eq("folder_id", data.to_folder_id);
    }
    return { moved, failed };
  });

export const reanalyzeEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_id: string }) => z.object({ email_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { classifyParsedEmail, loadAccountContext } = await import("../sync.server");
    const { rows } = await getEmailsDecrypted([data.email_id]);
    const email = rows[0];
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");
    if (!email.id || !email.gmail_account_id || !email.gmail_message_id) {
      throw new Error("Email is missing required identifiers");
    }
    const emailId = email.id;
    const emailAccountId = email.gmail_account_id;
    const emailMessageId = email.gmail_message_id;

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

    const accountContext = await loadAccountContext(email.gmail_account_id, context.userId);
    const result = await classifyParsedEmail(parsed, context.userId, email.gmail_account_id, {
      skipGmailLabelMatch: true,
      context: accountContext,
    });

    // Always make sure we have a summary on the row after Reanalyze, even when
    // the classifier (filter/label/domain rule) didn't run the AI summarizer.
    let summary = result.ai_summary || "";
    if (!summary) {
      try {
        const { summarizeEmail } = await import("../ai.server");
        summary = await summarizeEmail({
          from_name: parsed.from_name,
          from_addr: parsed.from_addr,
          subject: parsed.subject,
          body_text: parsed.body_text,
          snippet: parsed.snippet,
        });
      } catch (e) {
        logError("gmail.reanalyze.summarize_failed", { email_id: email.id }, e);
      }
    }

    // An always-inbox override now wins for this email, but it is sitting in a
    // folder. Restore it to the inbox (same steps as the manual "Move to Inbox"
    // action and the bulk reclassify path) so it shows up in the inbox view,
    // which filters on the INBOX label + is_archived = false.
    if (result.folder_id === null && result.classified_by === "inbox_override" && email.folder_id) {
      const { data: f } = await supabaseAdmin
        .from("folders")
        .select("gmail_label_id")
        .eq("id", email.folder_id)
        .maybeSingle();
      const fromLabel = f?.gmail_label_id ?? null;

      await restoreEmailToInbox({
        emailId: email.id,
        gmailAccountId: emailAccountId,
        gmailMessageId: emailMessageId,
        currentLabels: ((email.raw_labels as string[] | null) ?? []) as string[],
        fromLabel,
        classifiedBy: "inbox_override",
        classificationReason: result.classification_reason ?? "",
        aiConfidence: 1,
        aiSummary: summary || "",
        labelFailureLog: {
          event: "gmail.reanalyze.inbox_restore_label_failed",
          payload: { email_id: emailId },
        },
      });

      return {
        ok: true,
        folder_id: null,
        folder_name: null,
        classified_by: "inbox_override",
        classification_reason: result.classification_reason,
        changed: true,
      };
    }

    // The email's current folder now REJECTS this sender via its own
    // deterministic rules (a domain_in allowlist or a not_contains/not_equals
    // exclude). This is independent of the AI pass, so a flaky AI run can't
    // trigger it. Evict to the inbox using the same steps as the inbox_override
    // branch and the bulk reclassify path, so Gmail stays in sync and the next
    // sync won't revert it. Mirrors reclassifyEmails, so the single-email
    // Re-analyze and bulk Re-classify buttons agree.
    if (
      result.folder_id === null &&
      email.folder_id &&
      result.classified_by !== "ai_error" &&
      emailVetoedForFolder(parsed, email.folder_id, accountContext.filters)
    ) {
      const { data: f } = await supabaseAdmin
        .from("folders")
        .select("gmail_label_id, name")
        .eq("id", email.folder_id)
        .maybeSingle();
      const fromLabel = f?.gmail_label_id ?? null;
      const fromName = f?.name ?? null;

      const reason = fromName
        ? `Removed from "${fromName}" — sender excluded by folder rule`
        : "Removed from folder — sender excluded by folder rule";

      await restoreEmailToInbox({
        emailId: email.id,
        gmailAccountId: emailAccountId,
        gmailMessageId: emailMessageId,
        currentLabels: ((email.raw_labels as string[] | null) ?? []) as string[],
        fromLabel,
        classifiedBy: "excluded",
        classificationReason: reason,
        aiConfidence: 1,
        aiSummary: summary || "",
        labelFailureLog: {
          event: "gmail.reanalyze.inbox_restore_label_failed",
          payload: { email_id: emailId },
        },
      });

      return {
        ok: true,
        folder_id: null,
        folder_name: null,
        classified_by: "excluded",
        classification_reason: reason,
        changed: true,
      };
    }

    // If the classifier didn't pick a folder and the email already has one,
    // keep the current assignment regardless of WHY the classifier abstained
    // (AI no-match, global override, etc.). Reanalyze should
    // only move emails to a better folder, never silently clear them.
    if (result.folder_id === null && email.folder_id) {
      await updateEmailEncrypted({
        email_id: email.id,
        ai_summary: summary || "",
      });
      return {
        ok: true,
        folder_id: email.folder_id,
        folder_name: null,
        classified_by: "kept",
        classification_reason:
          result.classification_reason ||
          "Classifier found no better folder — kept current assignment",
        changed: false,
      };
    }

    const isSurfaced = result.classified_by === "surfaced_to_inbox";
    await updateEmailEncrypted({
      email_id: email.id,
      folder_id: result.folder_id ?? undefined,
      classified_by: result.classified_by,
      ai_confidence: result.ai_confidence ?? undefined,
      ai_summary: summary || "",
      classification_reason: result.classification_reason ?? "",
      matched_filter_ids: result.matched_filter_ids,
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

    // Surfaced mail must carry both its folder label AND the INBOX label.
    if (isSurfaced && result.folder_id) {
      const { data: sf } = await supabaseAdmin
        .from("folders")
        .select("gmail_label_id")
        .eq("id", result.folder_id)
        .maybeSingle();
      const addLabels = ["INBOX", ...(sf?.gmail_label_id ? [sf.gmail_label_id] : [])];
      try {
        await modifyMessage(email.gmail_account_id, email.gmail_message_id, addLabels, []);
      } catch (e) {
        logError("gmail.reanalyze.surface_label_failed", { email_id: emailId }, e);
      }
      return {
        ok: true,
        folder_id: result.folder_id,
        folder_name: null,
        classified_by: result.classified_by,
        classification_reason: result.classification_reason,
        changed: true,
      };
    }

    // Best-effort Gmail label sync if folder changed.
    if (email.folder_id !== result.folder_id) {
      const ids = [email.folder_id, result.folder_id].filter((x): x is string => !!x);
      let fromLabel: string | null = null;
      let toLabel: string | null = null;
      let toName: string | null = null;
      if (ids.length) {
        const { data: fs } = await supabaseAdmin
          .from("folders")
          .select("id, name, gmail_label_id")
          .in("id", ids);
        fromLabel = fs?.find((f) => f.id === email.folder_id)?.gmail_label_id ?? null;
        const tof = fs?.find((f) => f.id === result.folder_id);
        toLabel = tof?.gmail_label_id ?? null;
        toName = tof?.name ?? null;
      }
      if (fromLabel || toLabel) {
        try {
          await modifyMessage(
            email.gmail_account_id,
            email.gmail_message_id,
            toLabel ? [toLabel] : [],
            fromLabel ? [fromLabel] : [],
          );
        } catch (e) {
          logError("gmail.reanalyze.label_sync_failed", { email_id: email.id }, e);
        }
      }
      return {
        ok: true,
        folder_id: result.folder_id,
        folder_name: toName,
        classified_by: result.classified_by,
        classification_reason: result.classification_reason,
        changed: true,
      };
    }

    return {
      ok: true,
      folder_id: result.folder_id,
      folder_name: null,
      classified_by: result.classified_by,
      classification_reason: result.classification_reason,
      changed: false,
    };
  });

export const moveEmailToInbox = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_id: string; add_override?: "email" | "domain" | null }) =>
    z
      .object({
        email_id: z.string().uuid(),
        add_override: z.enum(["email", "domain"]).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select("id, user_id, folder_id, gmail_message_id, gmail_account_id, from_addr, raw_labels")
      .eq("id", data.email_id)
      .single();
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");

    let fromLabel: string | null = null;
    if (email.folder_id) {
      const { data: f } = await supabaseAdmin
        .from("folders")
        .select("gmail_label_id")
        .eq("id", email.folder_id)
        .maybeSingle();
      fromLabel = f?.gmail_label_id ?? null;
    }

    // Recompute raw_labels (add INBOX, drop the folder label), flip the row,
    // and sync Gmail. Without the raw_labels update the inbox view (which
    // filters on raw_labels @> ['INBOX']) keeps hiding the message.
    await restoreEmailToInbox({
      emailId: email.id,
      gmailAccountId: email.gmail_account_id,
      gmailMessageId: email.gmail_message_id,
      currentLabels: (email.raw_labels ?? []) as string[],
      fromLabel,
      classifiedBy: "manual_inbox",
      classificationReason: "Moved to Inbox manually",
      aiConfidence: 1,
      labelFailureLog: { event: "gmail.inbox.label_sync_failed" },
    });

    // Stop training AI on this mistake.
    if (email.folder_id) {
      await supabaseAdmin
        .from("folder_examples")
        .delete()
        .eq("folder_id", email.folder_id)
        .eq("gmail_message_id", email.gmail_message_id);
    }

    const domain = extractDomain(email.from_addr);
    let override_added: "email" | "domain" | null = null;
    if (data.add_override && email.from_addr) {
      const value = data.add_override === "email" ? email.from_addr.toLowerCase() : domain;
      if (value) {
        const { data: existing } = await supabaseAdmin
          .from("inbox_overrides")
          .select("id, gmail_account_id")
          .eq("user_id", context.userId)
          .eq("match_type", data.add_override)
          .eq("value", value)
          .maybeSingle();
        if (!existing) {
          // Store globally (no account) so the override keeps mail in the
          // inbox across every connected account, not just this one.
          await supabaseAdmin.from("inbox_overrides").insert({
            user_id: context.userId,
            gmail_account_id: null,
            match_type: data.add_override,
            value,
          });
          await invalidateAccountContextForUser(context.userId);
        } else if (existing.gmail_account_id) {
          // Promote a legacy account-scoped override to global.
          await supabaseAdmin
            .from("inbox_overrides")
            .update({ gmail_account_id: null })
            .eq("id", existing.id);
          await invalidateAccountContextForUser(context.userId);
        }
        override_added = data.add_override;
      }
    }

    return {
      ok: true,
      from_addr: email.from_addr,
      domain,
      override_added,
    };
  });

export const addInboxOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      value: string;
      match_type: "email" | "domain";
      reprocess_past?: boolean;
      gmail_account_id?: string;
    }) =>
      z
        .object({
          value: z.string().min(1).max(320),
          match_type: z.enum(["email", "domain"]),
          reprocess_past: z.boolean().optional(),
          gmail_account_id: z.string().uuid().optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const value = data.value.trim().toLowerCase().replace(/^@/, "");
    if (!value) throw new Error("Empty value");
    // Inbox overrides are user-wide: they apply to every connected account,
    // so we always store gmail_account_id = null. The unique constraint is
    // (user_id, match_type, value) and does NOT include gmail_account_id, so
    // the existence check matches those three columns only — an account-scoped
    // row counts as "already present".
    const { data: existing } = await supabaseAdmin
      .from("inbox_overrides")
      .select("id, gmail_account_id")
      .eq("user_id", context.userId)
      .eq("match_type", data.match_type)
      .eq("value", value)
      .maybeSingle();
    const already = !!existing;
    if (!already) {
      // Upsert with ignoreDuplicates as a safety net so a race can never
      // surface a raw duplicate-key error to the user.
      const { error } = await supabaseAdmin.from("inbox_overrides").upsert(
        {
          user_id: context.userId,
          gmail_account_id: null,
          match_type: data.match_type,
          value,
        },
        { onConflict: "user_id,match_type,value", ignoreDuplicates: true },
      );
      if (error) throw new Error(error.message);
      // Bust caches across every account this user owns so the new override
      // routes incoming mail immediately.
      await invalidateAccountContextForUser(context.userId);
    } else if (existing.gmail_account_id) {
      // Promote a legacy account-scoped override to global so it now protects
      // mail arriving on every connected account.
      await supabaseAdmin
        .from("inbox_overrides")
        .update({ gmail_account_id: null })
        .eq("id", existing.id);
      await invalidateAccountContextForUser(context.userId);
    }

    let reprocessed_count = 0;
    if (data.reprocess_past) {
      let q = supabaseAdmin
        .from("emails")
        .select("id, gmail_message_id, gmail_account_id, folder_id, from_addr, raw_labels")
        .eq("user_id", context.userId)
        .not("folder_id", "is", null);
      if (data.match_type === "email") {
        q = q.ilike("from_addr", value);
      } else {
        q = q.ilike("from_addr", `%@${value}`);
      }
      const { data: rows } = await q;
      const matches = (rows ?? []).filter((r) => {
        const fa = (r.from_addr || "").toLowerCase();
        return data.match_type === "email" ? fa === value : fa.split("@")[1] === value;
      });

      if (matches.length) {
        const folderIds = Array.from(
          new Set(matches.map((m) => m.folder_id).filter((x): x is string => !!x)),
        );
        const { data: fs } = await supabaseAdmin
          .from("folders")
          .select("id, gmail_label_id")
          .in("id", folderIds);
        const labelById = new Map((fs ?? []).map((f) => [f.id, f.gmail_label_id]));
        const reason = `Always-inbox: ${data.match_type} "${value}"`;

        const concurrency = 5;
        let i = 0;
        async function worker() {
          while (i < matches.length) {
            const m = matches[i++];
            try {
              const oldLabel = m.folder_id ? (labelById.get(m.folder_id) ?? null) : null;
              // Reprocess past path: row was filed into a folder (often
              // auto-archived with INBOX stripped). Restore INBOX locally
              // AND in Gmail so the row matches the inbox view filter
              // (raw_labels @> ['INBOX']) just like the runtime
              // inbox_override path in process-message.
              await restoreEmailToInbox({
                emailId: m.id,
                gmailAccountId: m.gmail_account_id,
                gmailMessageId: m.gmail_message_id,
                currentLabels: ((m as { raw_labels: string[] | null }).raw_labels ??
                  []) as string[],
                fromLabel: oldLabel,
                classifiedBy: "inbox_override",
                classificationReason: reason,
                aiSummary: "",
                labelFailureLog: {
                  event: "gmail.reprocess.label_sync_failed",
                  payload: { email_id: m.id },
                },
              });
              reprocessed_count++;
            } catch (e) {
              logError("gmail.reprocess.row_failed", { email_id: m.id }, e);
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(concurrency, matches.length) }, worker));
      }
    }

    return { ok: true, value, match_type: data.match_type, already, reprocessed_count };
  });
