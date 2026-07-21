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
export const triggerBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; count?: number }) =>
    z
      .object({ account_id: z.string().uuid(), count: z.number().min(1).max(100).optional() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    return backfillRecent(data.account_id, context.userId, data.count ?? 30);
  });

export const triggerWeekBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; days?: number; max?: number }) =>
    z
      .object({
        account_id: z.string().uuid(),
        days: z.number().int().min(1).max(30).optional(),
        max: z.number().int().min(1).max(2000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const days = data.days ?? 7;
    return backfillWindow(data.account_id, context.userId, {
      query: `-in:chats -in:trash -in:spam newer_than:${days}d`,
      maxMessages: data.max ?? 1000,
    });
  });

export const startDeepBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; months?: number }) =>
    z
      .object({
        account_id: z.string().uuid(),
        months: z.number().int().min(1).max(120).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    return startBackfillJob(data.account_id, context.userId, { months: data.months ?? 6 });
  });

export const getBackfillStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id?: string }) =>
    z.object({ account_id: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = supabaseAdmin
      .from("backfill_jobs")
      .select(
        "id, gmail_account_id, status, months, total_found, total_enqueued, already_had, started_at, finished_at, last_error",
      )
      .eq("user_id", context.userId);
    if (data.account_id) q = q.eq("gmail_account_id", data.account_id);

    // Prefer an active job; fall back to most recent finished one.
    const { data: active } = await q
      .in("status", ["listing", "processing"])
      .order("started_at", { ascending: false })
      .limit(1);
    let job = active?.[0] ?? null;
    if (!job) {
      const { data: recent } = await q.order("started_at", { ascending: false }).limit(1);
      job = recent?.[0] ?? null;
    }
    if (!job) return { job: null };

    // Compute remaining = un-drained message_jobs for that account.
    const { count } = await supabaseAdmin
      .from("message_jobs")
      .select("id", { count: "exact", head: true })
      .eq("gmail_account_id", job.gmail_account_id)
      .neq("status", "dlq");

    return { job: { ...job, remaining: count ?? 0 } };
  });

export const cancelDeepBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { job_id: string }) => z.object({ job_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    return cancelBackfillJob(data.job_id, context.userId);
  });

export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) =>
    z.object({ account_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const histResult = await syncSinceHistory(data.account_id);
    // Bulk catch-up: synchronously drain the messages we just enqueued
    // so the client's refetch sees them all at once instead of letting
    // them trickle in via the 5s cron lane. Runs in bounded rounds so a
    // backlog after a long absence mostly clears in one sync; the budget
    // keeps it under the Safari "Load failed" wall-clock and anything
    // beyond it stays in the queue for the cron lane.
    const catchup = await drainCatchupRounds(
      data.account_id,
      context.userId,
      "gmail.manual_sync.catchup_failed",
    );
    // Safety net: history events can be missed (webhook drops, expired
    // historyId, etc.), so always do a small recent backfill on manual sync.
    let recent_synced = 0;
    try {
      const r = await backfillRecent(data.account_id, context.userId, 30);
      recent_synced = r?.processed ?? 0;
    } catch (e) {
      logError(
        "gmail.manual_sync.backfill_failed",
        { account_id: data.account_id, user_id: context.userId },
        e,
      );
    }
    // Keep the manual refresh fast and reliable. The full reconcile makes up
    // to ~100 sequential Gmail API calls, which can run long enough that the
    // browser drops the request (Safari surfaces this as "Load failed"). The
    // background cron reconcile is the designated backstop, so here we only do
    // a small best-effort pass and never let it fail the whole sync.
    let recon: Awaited<ReturnType<typeof reconcileLocalInbox>> | undefined;
    try {
      recon = await reconcileLocalInbox(data.account_id, 20);
    } catch (e) {
      logError(
        "gmail.manual_sync.reconcile_failed",
        { account_id: data.account_id, user_id: context.userId },
        e,
      );
    }
    return { ...histResult, recent_synced, reconciled: recon, catchup };
  });

// Lightweight recurring sync for an open inbox. Pulls new mail via Gmail
// history and drains the queue in bounded rounds, but SKIPS the heavier
// backfillRecent + full reconcileLocalInbox that triggerSync runs — those
// stay on the 5-minute in-tab loop and the cron backstop. Cheap enough to
// run on a ~30s interval so the inbox keeps itself current without a
// manual refresh or page reload.
export const backgroundSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) =>
    z.object({ account_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const histResult = await syncSinceHistory(data.account_id);
    const catchup = await drainCatchupRounds(
      data.account_id,
      context.userId,
      "gmail.background_sync.catchup_failed",
    );
    return { ...histResult, catchup };
  });

export const renewGmailWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) =>
    z.object({ account_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const { data: accRow } = await supabaseAdmin
      .from("gmail_accounts")
      .select("email_address")
      .eq("id", data.account_id)
      .single();
    // Force renewal by passing null
    const watch = await ensureWatch(data.account_id, null);
    if (!watch) throw new Error("GMAIL_PUBSUB_TOPIC is not configured");
    await supabaseAdmin
      .from("gmail_accounts")
      .update({
        history_id: watch.historyId,
        watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
      })
      .eq("id", data.account_id);
    try {
      await supabaseAdmin.from("pubsub_events").insert({
        event_type: "watch_renew",
        email_address: accRow?.email_address ?? null,
        history_id: watch.historyId,
        details: `Watch armed against topic ${process.env.GMAIL_PUBSUB_TOPIC ?? "(unset)"} — expires ${new Date(parseInt(watch.expiration, 10)).toISOString()}`,
      });
    } catch (e) {
      logError("gmail.watch_renew.log_failed", { account_id: data.account_id }, e);
    }
    return { expiration: watch.expiration, topic: process.env.GMAIL_PUBSUB_TOPIC ?? null };
  });

export const markEmailRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; read: boolean }) =>
    z.object({ id: z.string().uuid(), read: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    try {
      await modifyMessage(
        email.gmail_account_id,
        email.gmail_message_id,
        data.read ? [] : ["UNREAD"],
        data.read ? ["UNREAD"] : [],
      );
    } catch (e) {
      logError("gmail.unknown_op_failed", {}, e);
    }
    await supabaseAdmin.from("emails").update({ is_read: data.read }).eq("id", data.id);
    return { ok: true };
  });

/**
 * On-demand read-state reconciliation for the signed-in user's connected
 * accounts. Pulls Gmail's current unread set per account and diffs it against
 * local read flags so the unread dots match Gmail. Called from the inbox on
 * mount and on tab focus; the 15-minute reconcile cron is the backstop.
 */
export const syncMyReadState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: accounts } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id")
      .eq("user_id", context.userId)
      .eq("needs_reconnect", false);
    let markedRead = 0;
    let markedUnread = 0;
    for (const acc of accounts ?? []) {
      try {
        const r = await syncReadState(acc.id);
        markedRead += r.marked_read;
        markedUnread += r.marked_unread;
      } catch (e) {
        logError("gmail.sync_my_read_state_failed", { account_id: acc.id }, e);
      }
    }
    return { ok: true, marked_read: markedRead, marked_unread: markedUnread };
  });

export const archiveEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    // Talk to Gmail first — if it fails, surface the error so we don't drift
    // out of sync with the canonical mailbox state.
    try {
      await modifyMessage(email.gmail_account_id, email.gmail_message_id, [], ["INBOX"]);
    } catch (e) {
      logError(
        "gmail.archive.modify_failed",
        {
          email_id: data.id,
          account_id: email.gmail_account_id,
          gmail_message_id: email.gmail_message_id,
        },
        e,
      );
      throw new Error((e as Error)?.message || "Failed to archive in Gmail", { cause: e });
    }
    // Pull the current raw_labels so we can strip INBOX in the same UPDATE
    // the realtime subscribers will see. Without this, the cached list keeps
    // raw_labels including INBOX → rowBelongsInList stays true → the row
    // never leaves the Inbox view until a full refetch.
    const { data: row } = await supabaseAdmin
      .from("emails")
      .select("raw_labels")
      .eq("id", data.id)
      .maybeSingle();
    const nextLabels = (row?.raw_labels ?? []).filter((l: string) => l !== "INBOX");
    await supabaseAdmin
      .from("emails")
      .update({ is_archived: true, raw_labels: nextLabels })
      .eq("id", data.id);
    return { ok: true };
  });

export const trashEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    try {
      await trashMessage(email.gmail_account_id, email.gmail_message_id);
    } catch (e) {
      logError(
        "gmail.archive.modify_failed",
        {
          email_id: data.id,
          account_id: email.gmail_account_id,
          gmail_message_id: email.gmail_message_id,
        },
        e,
      );
      // Do NOT delete the local row when Gmail wasn't updated: the message
      // is still live in Gmail's INBOX, so reconcile would re-ingest it and
      // the "trashed" email would ghost back. Surface the failure instead.
      throw new Error("Couldn't move the email to Gmail's trash — please try again.", {
        cause: e,
      });
    }
    await supabaseAdmin.from("emails").delete().eq("id", data.id);
    return { ok: true };
  });

export const generateReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    const draft = await suggestReply({
      from_name: email.from_name || "",
      subject: email.subject || "",
      body_text: email.body_text || "",
    });
    await setReplyDraftEncrypted({ email_id: data.id, user_id: context.userId, draft_text: draft });
    return { draft };
  });

export const sendReply = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; body: string }) =>
    z.object({ id: z.string().uuid(), body: z.string().min(1).max(20000) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    const subject = email.subject?.startsWith("Re:") ? email.subject : `Re: ${email.subject ?? ""}`;
    await sendMessage(
      email.gmail_account_id,
      email.from_addr || "",
      subject,
      data.body,
      email.thread_id || undefined,
      email.gmail_message_id,
    );
    return { ok: true };
  });
