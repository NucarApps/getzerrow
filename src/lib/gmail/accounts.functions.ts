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
type GmailAccountStatusRow = {
  id: string;
  email_address: string;
  history_id: string | null;
  watch_expiration: string | null;
  last_poll_at: string | null;
  created_at: string;
  refresh_token_enc: string | null;
  needs_reconnect: boolean | null;
  refresh_token_present: boolean;
};
export const listMyGmailAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Use the already-validated user id from middleware instead of relying on
    // PostgREST auth.uid() inside the RPC. That keeps account loading stable
    // across preview/live server-function auth contexts while only returning
    // safe account metadata to the browser.
    const { data, error } = await supabaseAdmin
      .from("gmail_accounts")
      .select(
        "id,email_address,history_id,watch_expiration,last_poll_at,created_at,refresh_token_enc,needs_reconnect",
      )
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`Failed to load Gmail accounts: ${error.message}`);
    const rows = (data ?? []) as GmailAccountStatusRow[];
    return {
      accounts: rows.map((r) => ({
        id: r.id,
        email_address: r.email_address,
        history_id: r.history_id,
        watch_expiration: r.watch_expiration,
        last_poll_at: r.last_poll_at,
        created_at: r.created_at,
        needs_reauth: r.needs_reconnect === true || r.refresh_token_enc === null,
      })),
    };
  });

export const startConnectGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { login_hint?: string } | undefined) =>
    z.object({ login_hint: z.string().email().optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const host = getRequestHost();
    const origin = `https://${host}`;
    const redirectUri = getRedirectUri(origin);
    const state = signState(context.userId);
    return { url: buildAuthorizeUrl(redirectUri, state, data.login_hint) };
  });

export const connectGmailFromSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      email_address: string;
    }) =>
      z
        .object({
          access_token: z.string().min(1),
          refresh_token: z.string().min(1),
          expires_in: z
            .number()
            .int()
            .positive()
            .max(60 * 60 * 24),
          email_address: z.string().email(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    // Goes through upsert_gmail_oauth_account so the tokens are encrypted
    // (pgp_sym via EMAIL_ENC_KEY) before they touch the table.
    type UpsertRpc = {
      rpc: (
        fn: "upsert_gmail_oauth_account",
        args: {
          p_user_id: string;
          p_email_address: string;
          p_access_token: string;
          p_refresh_token: string;
          p_token_expires_at: string;
          p_key: string;
        },
      ) => Promise<{ data: string | null; error: { message: string } | null }>;
    };
    const { data: accountId, error } = await (supabaseAdmin as unknown as UpsertRpc).rpc(
      "upsert_gmail_oauth_account",
      {
        p_user_id: context.userId,
        p_email_address: data.email_address.toLowerCase(),
        p_access_token: data.access_token,
        p_refresh_token: data.refresh_token,
        p_token_expires_at: expiresAt,
        p_key: process.env.EMAIL_ENC_KEY!,
      },
    );
    if (error || !accountId) throw new Error(`Failed to save account: ${error?.message}`);
    const account = { id: accountId };
    // Audit: a Gmail mailbox was granted restricted-scope access for this user.
    logAudit("gmail.connected", { user_id: context.userId, account_id: account.id });

    try {
      const watch = await ensureWatch(account.id, null);
      if (watch) {
        await supabaseAdmin
          .from("gmail_accounts")
          .update({
            history_id: watch.historyId,
            watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
          })
          .eq("id", account.id);
      }
    } catch (e) {
      logError(
        "gmail.auto_connect.ensure_watch_failed",
        { account_id: account.id, user_id: context.userId },
        e,
      );
    }

    try {
      await backfillRecent(account.id, context.userId, 30);
    } catch (e) {
      logError(
        "gmail.auto_connect.backfill_failed",
        { account_id: account.id, user_id: context.userId },
        e,
      );
    }

    // Kick off a deep 6-month background import. Idempotent — won't spawn
    // duplicates if the user re-signs in while one is still active.
    try {
      await startBackfillJob(account.id, context.userId, { months: 6 });
    } catch (e) {
      logError(
        "gmail.auto_connect.start_backfill_failed",
        { account_id: account.id, user_id: context.userId },
        e,
      );
    }

    return { account_id: account.id };
  });

export const disconnectGmailAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) =>
    z.object({ account_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    try {
      await stopWatch(data.account_id);
    } catch (e) {
      logError(
        "gmail.disconnect.stop_watch_failed",
        { account_id: data.account_id, user_id: context.userId },
        e,
      );
    }
    // Best-effort: revoke the Google OAuth grant so the refresh token is dead
    // server-side at Google before we drop our encrypted copy.
    try {
      const { revokeGoogleOAuthForAccount } = await import("../google-oauth.server");
      await revokeGoogleOAuthForAccount(data.account_id);
    } catch (e) {
      logError(
        "gmail.disconnect.revoke_failed",
        { account_id: data.account_id, user_id: context.userId },
        e,
      );
    }

    // Purge this mailbox's synced content so disconnecting actually removes the
    // restricted Gmail/Calendar data we hold (data minimisation / Limited Use),
    // rather than leaving it orphaned under a now-dangling gmail_account_id.
    // Done server-side in one transactional RPC (see migration
    // delete_gmail_account_content) so a large mailbox can't time out mid-purge.
    // User-level config (folders, filters, contacts) is shared across mailboxes
    // and is intentionally left intact.
    const userId = context.userId;
    const accountId = data.account_id;
    let purgedEmails = 0;
    let purgeOk = false;
    try {
      type PurgeRpc = {
        rpc: (
          fn: "delete_gmail_account_content",
          args: { p_account_id: string; p_user_id: string },
        ) => Promise<{ data: number | null; error: { message: string } | null }>;
      };
      const { data: deleted, error } = await (supabaseAdmin as unknown as PurgeRpc).rpc(
        "delete_gmail_account_content",
        { p_account_id: accountId, p_user_id: userId },
      );
      if (error) {
        logError(
          "gmail.disconnect.purge_failed",
          { account_id: accountId, user_id: userId },
          error,
        );
      } else {
        purgedEmails = deleted ?? 0;
        purgeOk = true;
      }
    } catch (e) {
      logError("gmail.disconnect.purge_failed", { account_id: accountId, user_id: userId }, e);
    }

    await supabaseAdmin.from("gmail_accounts").delete().eq("id", data.account_id);
    // Audit: restricted-scope access revoked and this mailbox's synced data purged.
    // purge_ok=false flags residual data left behind (e.g. RPC error) for follow-up.
    logAudit("gmail.disconnected", {
      user_id: userId,
      account_id: accountId,
      emails_purged: purgedEmails,
      purge_ok: purgeOk,
    });
    return { ok: true };
  });

export const listGmailLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) =>
    z.object({ account_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const r = await listLabels(data.account_id);
    const labels = (r.labels ?? []).filter((l) => l.type === "user");
    return { labels };
  });

export const generateFolderAiRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { purpose: string; folder_name?: string }) =>
    z
      .object({
        purpose: z.string().min(1).max(1000),
        folder_name: z.string().min(1).max(100).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const rule = await generateAiRuleFromPurpose({
      purpose: data.purpose,
      folderName: data.folder_name,
    });
    return { rule };
  });

export const generateFolderAiRuleFromLabel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name, gmail_label_id, gmail_account_id")
      .eq("id", data.folder_id)
      .maybeSingle();
    if (!folder || folder.user_id !== context.userId) throw new Error("Folder not found");
    if (!folder.gmail_label_id) throw new Error("Link a Gmail label first, then save.");

    const MAX_SAMPLES = 40;
    const list = await listMessages(folder.gmail_account_id, {
      maxResults: MAX_SAMPLES,
      labelIds: [folder.gmail_label_id],
    });
    const ids = (list.messages ?? []).map((m) => m.id).slice(0, MAX_SAMPLES);
    if (ids.length === 0) {
      throw new Error("No emails found under this label to learn from.");
    }

    const samples: Array<{ from: string; subject: string; snippet: string }> = [];
    const CONCURRENCY = 10;
    async function fetchOne(id: string) {
      try {
        const raw = await getMessageMetadata(folder!.gmail_account_id, id);
        const p = parseMessage(raw);
        samples.push({
          from: `${p.from_name ?? ""} ${p.from_addr ?? ""}`.trim(),
          subject: p.subject ?? "",
          snippet: p.snippet ?? "",
        });
      } catch {
        // Skip messages we can't read; the sample doesn't need to be complete.
      }
    }
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(ids.slice(i, i + CONCURRENCY).map(fetchOne));
    }

    const rule = await generateAiRuleFromLabelSamples({
      folderName: folder.name,
      samples,
    });
    return { rule };
  });

export const createGmailLabel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; name: string; parent_label_id?: string }) =>
    z
      .object({
        account_id: z.string().uuid(),
        name: z.string().min(1).max(100),
        parent_label_id: z.string().min(1).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const labels = await listLabels(data.account_id);
    let fullName = `Zerrow/${data.name}`;
    if (data.parent_label_id) {
      const parent = labels.labels?.find((l) => l.id === data.parent_label_id);
      if (!parent) throw new Error("Parent label not found");
      if (!parent.name.startsWith("Zerrow/") && parent.name !== "Zerrow") {
        throw new Error("Parent label must be within Zerrow namespace");
      }
      fullName = `${parent.name}/${data.name}`;
    }
    const existing = labels.labels?.find((l) => l.name === fullName);
    if (existing) return { id: existing.id };
    const created = await createLabel(data.account_id, fullName);
    return { id: created.id };
  });

export const learnFolderFromLabel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    return learnFromLinkedLabel(data.folder_id, context.userId);
  });

export const applyFolderLabelToLocal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: folder } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name, gmail_label_id, gmail_account_id")
      .eq("id", data.folder_id)
      .maybeSingle();
    if (!folder || folder.user_id !== context.userId) throw new Error("Folder not found");
    if (!folder.gmail_label_id) throw new Error("Folder is not linked to a Gmail label");
    const labelId = folder.gmail_label_id;

    // Pull local emails in this folder that don't already carry the label.
    const { data: rows } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, gmail_account_id, raw_labels")
      .eq("folder_id", folder.id)
      .eq("user_id", context.userId)
      .limit(1000);

    let synced = 0;
    let failed = 0;
    const CONCURRENCY = 8;
    const todo = (rows ?? []).filter(
      (r) => !Array.isArray(r.raw_labels) || !r.raw_labels.includes(labelId),
    );
    const newLabels = [labelId];

    async function one(r: (typeof todo)[number]) {
      try {
        await modifyMessage(r.gmail_account_id, r.gmail_message_id, newLabels, ["INBOX"]);
        const merged = Array.from(new Set([...(r.raw_labels ?? []), labelId])).filter(
          (l) => l !== "INBOX",
        );
        await supabaseAdmin
          .from("emails")
          .update({ raw_labels: merged, is_archived: true })
          .eq("id", r.id);
        synced++;
      } catch (e) {
        logError("gmail.apply_folder_label.failed", { gmail_message_id: r.gmail_message_id }, e);
        failed++;
      }
    }

    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      await Promise.all(todo.slice(i, i + CONCURRENCY).map(one));
    }
    return { total: todo.length, synced, failed };
  });
