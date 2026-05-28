import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { backfillRecent, backfillWindow, syncSinceHistory, learnFromLinkedLabel, reconcileLocalInbox, loadOlderFromLabel, runMessageJobs, retryMessageJob, enqueueMessageJob, startBackfillJob, cancelBackfillJob, invalidateAccountContext, invalidateAccountContextForUser } from "./sync.server";
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
import { suggestReply, suggestRuleUpdates, suggestFolderFromEmails } from "./ai.server";
import { computeNextRun, enqueueFolderSummaryJob, runFolderSummary } from "./summaries.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signState, buildAuthorizeUrl, getRedirectUri } from "./google-oauth.server";
import { getRequestHost } from "@tanstack/react-start/server";
import { logError } from "./log.server";
import { removeLabelsFromCurrent } from "./sync/label-merge";
import { buildGmailQueries } from "./sync/gmail-query-builder";
import { matchByFilters } from "./sync/filter-engine";
import type { Folder, Filter, RuleNode } from "./sync/types";
import { upsertEmailEncrypted, updateEmailEncrypted, setReplyDraftEncrypted, insertFolderExampleEncrypted } from "./sync/encrypted-writer";
import { getEmailsDecrypted } from "./sync/encrypted-reader";

async function getOwnedAccount(userId: string, accountId: string) {
  const { data, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, user_id")
    .eq("id", accountId)
    .single();
  if (error || !data) throw new Error("Gmail account not found");
  if (data.user_id !== userId) throw new Error("Not authorized for this account");
  return data;
}

async function getEmailAccount(userId: string, emailId: string) {
  // Decrypts body_text + subject + from_name via the SECURITY DEFINER
  // get_emails_decrypted RPC. supabaseAdmin bypasses RLS; we enforce
  // user_id below.
  const { rows, error } = await getEmailsDecrypted([emailId]);
  if (error) throw new Error(error);
  const data = rows[0];
  if (!data) throw new Error("Email not found");
  if (data.user_id !== userId) throw new Error("Not authorized");
  if (!data.gmail_message_id || !data.gmail_account_id) throw new Error("Email is missing Gmail identifiers");
  return {
    gmail_message_id: data.gmail_message_id,
    gmail_account_id: data.gmail_account_id,
    user_id: data.user_id,
    thread_id: data.thread_id,
    from_addr: data.from_addr,
    subject: data.subject,
    body_text: data.body_text,
    from_name: data.from_name,
  };
}

type GmailAccountStatusRow = {
  id: string;
  email_address: string;
  history_id: string | null;
  watch_expiration: string | null;
  last_poll_at: string | null;
  created_at: string;
  refresh_token_present: boolean;
};
type GmailAccountStatusRpc = {
  rpc: (
    fn: "list_my_gmail_accounts_with_status",
    args: Record<string, never>,
  ) => Promise<{ data: GmailAccountStatusRow[] | null; error: { message: string } | null }>;
};

export const listMyGmailAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // Use the authenticated client so the SECURITY DEFINER RPC sees the
    // current user's auth.uid() — supabaseAdmin would run as service role
    // and return an empty set.
    const { data, error } = await (context.supabase as unknown as GmailAccountStatusRpc).rpc(
      "list_my_gmail_accounts_with_status",
      {},
    );
    if (error) throw new Error(`Failed to load Gmail accounts: ${error.message}`);
    const rows = data ?? [];
    return {
      accounts: rows.map((r) => ({
        id: r.id,
        email_address: r.email_address,
        history_id: r.history_id,
        watch_expiration: r.watch_expiration,
        last_poll_at: r.last_poll_at,
        created_at: r.created_at,
        needs_reauth: !r.refresh_token_present,
      })),
    };
  });

export const startConnectGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { login_hint?: string } | undefined) =>
    z.object({ login_hint: z.string().email().optional() }).parse(d ?? {})
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
  .inputValidator((d: { access_token: string; refresh_token: string; expires_in: number; email_address: string }) =>
    z.object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      expires_in: z.number().int().positive().max(60 * 60 * 24),
      email_address: z.string().email(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    // Goes through upsert_gmail_oauth_account so the tokens are encrypted
    // with pgsodium AEAD before they touch the table.
    type UpsertRpc = { rpc: (fn: "upsert_gmail_oauth_account", args: {
      p_user_id: string;
      p_email_address: string;
      p_access_token: string;
      p_refresh_token: string;
      p_token_expires_at: string;
    }) => Promise<{ data: string | null; error: { message: string } | null }> };
    const { data: accountId, error } = await (supabaseAdmin as unknown as UpsertRpc).rpc(
      "upsert_gmail_oauth_account",
      {
        p_user_id: context.userId,
        p_email_address: data.email_address.toLowerCase(),
        p_access_token: data.access_token,
        p_refresh_token: data.refresh_token,
        p_token_expires_at: expiresAt,
      },
    );
    if (error || !accountId) throw new Error(`Failed to save account: ${error?.message}`);
    const account = { id: accountId };

    try {
      const watch = await ensureWatch(account.id, null);
      if (watch) {
        await supabaseAdmin.from("gmail_accounts").update({
          history_id: watch.historyId,
          watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
        }).eq("id", account.id);
      }
    } catch (e) {
      logError("gmail.auto_connect.ensure_watch_failed", { account_id: account.id, user_id: context.userId }, e);
    }

    try {
      await backfillRecent(account.id, context.userId, 30);
    } catch (e) {
      logError("gmail.auto_connect.backfill_failed", { account_id: account.id, user_id: context.userId }, e);
    }

    // Kick off a deep 6-month background import. Idempotent — won't spawn
    // duplicates if the user re-signs in while one is still active.
    try {
      await startBackfillJob(account.id, context.userId, { months: 6 });
    } catch (e) {
      logError("gmail.auto_connect.start_backfill_failed", { account_id: account.id, user_id: context.userId }, e);
    }


    return { account_id: account.id };
  });

export const disconnectGmailAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) => z.object({ account_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    try { await stopWatch(data.account_id); } catch (e) { logError("gmail.disconnect.stop_watch_failed", { account_id: data.account_id, user_id: context.userId }, e); }
    // Best-effort: revoke the Google OAuth grant so the refresh token is dead
    // server-side at Google before we drop our encrypted copy.
    try {
      const { revokeGoogleOAuthForAccount } = await import("./google-oauth.server");
      await revokeGoogleOAuthForAccount(data.account_id);
    } catch (e) {
      logError("gmail.disconnect.revoke_failed", { account_id: data.account_id, user_id: context.userId }, e);
    }
    await supabaseAdmin.from("gmail_accounts").delete().eq("id", data.account_id);
    return { ok: true };
  });


export const listGmailLabels = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) => z.object({ account_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const r = await listLabels(data.account_id);
    const labels = (r.labels ?? []).filter((l) => l.type === "user");
    return { labels };
  });

export const createGmailLabel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; name: string; parent_label_id?: string }) =>
    z.object({
      account_id: z.string().uuid(),
      name: z.string().min(1).max(100),
      parent_label_id: z.string().min(1).optional(),
    }).parse(d)
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

    async function one(r: typeof todo[number]) {
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


export const loadOlderFromGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; before_received_at: string | null }) =>
    z
      .object({
        folder_id: z.string().uuid(),
        before_received_at: z.string().datetime({ offset: true }).nullable(),
      })
      .parse(d)
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
      supabaseAdmin
        .from("folder_examples")
        .select("from_addr")
        .eq("folder_id", data.folder_id),
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
    z.object({
      folder_id: z.string().uuid(),
      domain: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i),
    }).parse(d)
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
    z.object({
      from_folder_id: z.string().uuid(),
      to_folder_id: z.string().uuid(),
      domain: z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i),
    }).parse(d)
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
      const { error: upErr } = await supabaseAdmin
        .from("emails")
        .update({
          folder_id: data.to_folder_id,
          classified_by: "domain_rule",
          ai_confidence: 1,
          classification_reason: `Domain rule: ${domain} → ${to.name}`,
        })
        .in("id", ids);
      if (upErr) throw new Error(upErr.message);

      // Best-effort Gmail label sync
      if (from.gmail_label_id || to.gmail_label_id) {
        const addLabels = to.gmail_label_id ? [to.gmail_label_id] : [];
        const removeLabels = from.gmail_label_id ? [from.gmail_label_id] : [];
        await Promise.all(
          (matches ?? []).map(async (m) => {
            try {
              await modifyMessage(m.gmail_account_id, m.gmail_message_id, addLabels, removeLabels);
            } catch (e) {
              logError("gmail.reassign.label_modify_failed", { account_id: m.gmail_account_id, gmail_message_id: m.gmail_message_id }, e);
            }
          })
        );
      }
    }

    // Remove source folder examples for this domain so the suggestion stops reappearing
    const { data: srcExamples } = await supabaseAdmin
      .from("folder_examples")
      .select("id, from_addr, gmail_message_id, subject, snippet, gmail_account_id")
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
        subject: e.subject,
        snippet: e.snippet,
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

export const triggerBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; count?: number }) =>
    z.object({ account_id: z.string().uuid(), count: z.number().min(1).max(100).optional() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    return backfillRecent(data.account_id, context.userId, data.count ?? 30);
  });

export const triggerWeekBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string; days?: number; max?: number }) =>
    z.object({
      account_id: z.string().uuid(),
      days: z.number().int().min(1).max(30).optional(),
      max: z.number().int().min(1).max(2000).optional(),
    }).parse(d)
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
    z.object({
      account_id: z.string().uuid(),
      months: z.number().int().min(1).max(120).optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    return startBackfillJob(data.account_id, context.userId, { months: data.months ?? 6 });
  });

export const getBackfillStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id?: string }) =>
    z.object({ account_id: z.string().uuid().optional() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    let q = supabaseAdmin
      .from("backfill_jobs")
      .select("id, gmail_account_id, status, months, total_found, total_enqueued, already_had, started_at, finished_at, last_error")
      .eq("user_id", context.userId);
    if (data.account_id) q = q.eq("gmail_account_id", data.account_id);

    // Prefer an active job; fall back to most recent finished one.
    const { data: active } = await q
      .in("status", ["listing", "processing"])
      .order("started_at", { ascending: false })
      .limit(1);
    let job = active?.[0] ?? null;
    if (!job) {
      const { data: recent } = await q
        .order("started_at", { ascending: false })
        .limit(1);
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
  .inputValidator((d: { account_id: string }) => z.object({ account_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const histResult = await syncSinceHistory(data.account_id);
    // Safety net: history events can be missed (webhook drops, expired
    // historyId, etc.), so always do a small recent backfill on manual sync.
    let recent_synced = 0;
    try {
      const r = await backfillRecent(data.account_id, context.userId, 30);
      recent_synced = r?.processed ?? 0;
    } catch (e) {
      logError("gmail.manual_sync.backfill_failed", { account_id: data.account_id, user_id: context.userId }, e);
    }
    const recon = await reconcileLocalInbox(data.account_id, 100);
    return { ...histResult, recent_synced, reconciled: recon };
  });

export const renewGmailWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) => z.object({ account_id: z.string().uuid() }).parse(d))
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
    await supabaseAdmin.from("gmail_accounts").update({
      history_id: watch.historyId,
      watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
    }).eq("id", data.account_id);
    try {
      await supabaseAdmin.from("pubsub_events").insert({
        event_type: "watch_renew",
        email_address: accRow?.email_address ?? null,
        history_id: watch.historyId,
        details: `Watch armed against topic ${process.env.GMAIL_PUBSUB_TOPIC ?? "(unset)"} — expires ${new Date(parseInt(watch.expiration, 10)).toISOString()}`,
      });
    } catch (e) { logError("gmail.watch_renew.log_failed", { account_id: data.account_id }, e); }
    return { expiration: watch.expiration, topic: process.env.GMAIL_PUBSUB_TOPIC ?? null };
  });


export const markEmailRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; read: boolean }) =>
    z.object({ id: z.string().uuid(), read: z.boolean() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    try {
      await modifyMessage(
        email.gmail_account_id,
        email.gmail_message_id,
        data.read ? [] : ["UNREAD"],
        data.read ? ["UNREAD"] : []
      );
    } catch (e) { logError("gmail.unknown_op_failed", {}, e); }
    await supabaseAdmin.from("emails").update({ is_read: data.read }).eq("id", data.id);
    return { ok: true };
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
      logError("gmail.archive.modify_failed", { email_id: data.id, account_id: email.gmail_account_id, gmail_message_id: email.gmail_message_id }, e);
      throw new Error((e as Error)?.message || "Failed to archive in Gmail");
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
    try { await trashMessage(email.gmail_account_id, email.gmail_message_id); } catch (e) { logError("gmail.archive.modify_failed", { email_id: data.id, account_id: email.gmail_account_id, gmail_message_id: email.gmail_message_id }, e); }
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
    z.object({ id: z.string().uuid(), body: z.string().min(1).max(20000) }).parse(d)
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
      email.gmail_message_id
    );
    return { ok: true };
  });

export const listFolderHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string; limit?: number; offset?: number }) =>
    z.object({
      folder_id: z.string().uuid(),
      limit: z.number().min(1).max(200).optional(),
      offset: z.number().min(0).max(10000).optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { data: folder } = await supabaseAdmin
      .from("folders").select("id, user_id").eq("id", data.folder_id).single();
    if (!folder || folder.user_id !== context.userId) throw new Error("Not authorized");
    const limit = data.limit ?? 25;
    const offset = data.offset ?? 0;
    const { data: rows } = await supabaseAdmin
      .from("emails")
      .select("id, subject, from_addr, from_name, received_at, classified_by, ai_confidence, ai_summary, snippet")
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id)
      .order("received_at", { ascending: false })
      .range(offset, offset + limit); // fetch one extra to detect has_more
    const all = rows ?? [];
    const has_more = all.length > limit;
    return { emails: has_more ? all.slice(0, limit) : all, has_more, next_offset: offset + limit };
  });

export const suggestRecategorization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_id: string; to_folder_id: string }) =>
    z.object({ email_id: z.string().uuid(), to_folder_id: z.string().uuid() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { rows } = await getEmailsDecrypted([data.email_id]);
    const email = rows[0];
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");
    if (!email.folder_id) throw new Error("Email has no source folder");
    if (email.folder_id === data.to_folder_id) throw new Error("Source and target folders must differ");

    const { data: folders } = await supabaseAdmin
      .from("folders")
      .select("id, user_id, name, ai_rule, learned_profile")
      .in("id", [email.folder_id, data.to_folder_id]);
    const source = folders?.find((f) => f.id === email.folder_id);
    const target = folders?.find((f) => f.id === data.to_folder_id);
    if (!source || !target || source.user_id !== context.userId || target.user_id !== context.userId) {
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
        source: { name: source.name, ai_rule: source.ai_rule, learned_profile: source.learned_profile },
        target: { name: target.name, ai_rule: target.ai_rule, learned_profile: target.learned_profile },
      });
      return {
        source: {
          id: source.id, name: source.name,
          current_rule: source.ai_rule, current_profile: source.learned_profile,
          ...sug.source,
        },
        target: {
          id: target.id, name: target.name,
          current_rule: target.ai_rule, current_profile: target.learned_profile,
          ...sug.target,
        },
        error: null as string | null,
      };
    } catch (e: any) {
      logError("gmail.suggest_recat.ai_failed", { user_id: context.userId }, e);
      return {
        source: {
          id: source.id, name: source.name,
          current_rule: source.ai_rule, current_profile: source.learned_profile,
          proposed_rule: source.ai_rule ?? "", proposed_profile: source.learned_profile ?? "",
          why: "AI suggestion unavailable — you can still apply the move.",
        },
        target: {
          id: target.id, name: target.name,
          current_rule: target.ai_rule, current_profile: target.learned_profile,
          proposed_rule: target.ai_rule ?? "", proposed_profile: target.learned_profile ?? "",
          why: "AI suggestion unavailable — you can still apply the move.",
        },
        error: e?.message ?? "AI request failed",
      };
    }
  });

export const applyRecategorization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    email_id: string; to_folder_id: string;
    apply_source: boolean; apply_target: boolean;
    source_rule?: string | null; source_profile?: string | null;
    target_rule?: string | null; target_profile?: string | null;
  }) =>
    z.object({
      email_id: z.string().uuid(),
      to_folder_id: z.string().uuid(),
      apply_source: z.boolean(),
      apply_target: z.boolean(),
      source_rule: z.string().max(10000).nullable().optional(),
      source_profile: z.string().max(10000).nullable().optional(),
      target_rule: z.string().max(10000).nullable().optional(),
      target_profile: z.string().max(10000).nullable().optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const { data: email } = await supabaseAdmin
      .from("emails")
      .select("id, user_id, folder_id, gmail_message_id, gmail_account_id, from_addr, subject, snippet")
      .eq("id", data.email_id).single();
    if (!email || email.user_id !== context.userId) throw new Error("Email not found");
    if (!email.folder_id) throw new Error("Email has no source folder");
    const fromFolderId = email.folder_id;
    if (fromFolderId === data.to_folder_id) throw new Error("Source and target folders must differ");

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
    await supabaseAdmin.from("emails")
      .update({
        folder_id: data.to_folder_id,
        classified_by: "manual_move",
        ai_confidence: 1,
        classification_reason: `Re-categorized from "${from.name}" to "${to.name}"`,
      })
      .eq("id", email.id);

    // Best-effort Gmail label sync
    if (from.gmail_label_id || to.gmail_label_id) {
      try {
        await modifyMessage(
          email.gmail_account_id,
          email.gmail_message_id,
          to.gmail_label_id ? [to.gmail_label_id] : [],
          from.gmail_label_id ? [from.gmail_label_id] : []
        );
      } catch (e) { logError("gmail.label_sync.failed", {}, e); }
    }

    // Move example from source → target so AI signal reflects the correction
    await supabaseAdmin.from("folder_examples")
      .delete().eq("folder_id", fromFolderId).eq("gmail_message_id", email.gmail_message_id);
    await insertFolderExampleEncrypted({
      folder_id: data.to_folder_id,
      user_id: context.userId,
      gmail_message_id: email.gmail_message_id,
      gmail_account_id: email.gmail_account_id,
      from_addr: email.from_addr,
      subject: email.subject,
      snippet: email.snippet,
      source: "correction",
    });

    let source_updated = false;
    let target_updated = false;
    const now = new Date().toISOString();
    if (data.apply_source) {
      const patch: { last_learned_at: string; ai_rule?: string | null; learned_profile?: string | null } = { last_learned_at: now };
      if (data.source_rule !== undefined) patch.ai_rule = data.source_rule;
      if (data.source_profile !== undefined) patch.learned_profile = data.source_profile;
      await supabaseAdmin.from("folders").update(patch).eq("id", fromFolderId);
      source_updated = true;
    }
    if (data.apply_target) {
      const patch: { last_learned_at: string; ai_rule?: string | null; learned_profile?: string | null } = { last_learned_at: now };
      if (data.target_rule !== undefined) patch.ai_rule = data.target_rule;
      if (data.target_profile !== undefined) patch.learned_profile = data.target_profile;
      await supabaseAdmin.from("folders").update(patch).eq("id", data.to_folder_id);
      target_updated = true;
    }

    return { moved: 1, source_updated, target_updated };
  });

// ============ Folder summary schedules ============

const ianaTz = z.string().min(1).max(64).regex(/^[A-Za-z0-9_+\-/]+$/);

async function getOwnedFolder(userId: string, folderId: string) {
  const { data, error } = await supabaseAdmin
    .from("folders")
    .select("id, user_id, gmail_account_id")
    .eq("id", folderId)
    .single();
  if (error || !data) throw new Error("Folder not found");
  if (data.user_id !== userId) throw new Error("Not authorized");
  return data;
}

async function getOwnedSchedule(userId: string, id: string) {
  const { data, error } = await supabaseAdmin
    .from("folder_summary_schedules")
    .select("id, user_id, folder_id, hour, minute, timezone, enabled")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error("Schedule not found");
  if (data.user_id !== userId) throw new Error("Not authorized");
  return data;
}

export const listFolderSummaries = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) =>
    z.object({ folder_id: z.string().uuid() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    await getOwnedFolder(context.userId, data.folder_id);
    const { data: rows } = await supabaseAdmin
      .from("folder_summary_schedules")
      .select("id, name, instructions, hour, minute, timezone, enabled, last_run_at, next_run_at, last_error")
      .eq("folder_id", data.folder_id)
      .order("created_at", { ascending: true });
    return { schedules: rows ?? [] };
  });

export const createFolderSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    folder_id: string; name: string; instructions: string;
    hour: number; minute: number; timezone: string;
  }) =>
    z.object({
      folder_id: z.string().uuid(),
      name: z.string().min(1).max(100),
      instructions: z.string().max(50000),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      timezone: ianaTz,
    }).parse(d)
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
  .inputValidator((d: {
    id: string;
    name?: string; instructions?: string;
    hour?: number; minute?: number; timezone?: string;
    enabled?: boolean;
  }) =>
    z.object({
      id: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      instructions: z.string().max(50000).optional(),
      hour: z.number().int().min(0).max(23).optional(),
      minute: z.number().int().min(0).max(59).optional(),
      timezone: ianaTz.optional(),
      enabled: z.boolean().optional(),
    }).parse(d)
  )
  .handler(async ({ data, context }) => {
    const existing = await getOwnedSchedule(context.userId, data.id);
    const patch: {
      name?: string; instructions?: string;
      hour?: number; minute?: number; timezone?: string;
      enabled?: boolean; next_run_at?: string;
    } = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.instructions !== undefined) patch.instructions = data.instructions;
    if (data.hour !== undefined) patch.hour = data.hour;
    if (data.minute !== undefined) patch.minute = data.minute;
    if (data.timezone !== undefined) patch.timezone = data.timezone;
    if (data.enabled !== undefined) patch.enabled = data.enabled;

    const timeChanged = data.hour !== undefined || data.minute !== undefined || data.timezone !== undefined;
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
    const { jobId } = await enqueueFolderSummaryJob({ scheduleId: data.id, userId: context.userId });
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

function extractDomain(addr: string | null): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  return addr.slice(at + 1).toLowerCase().replace(/[>\s]+$/g, "");
}

import { performMove } from "./move-email.server";


export const moveEmailToFolder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_id: string; to_folder_id: string }) =>
    z.object({
      email_id: z.string().uuid(),
      to_folder_id: z.string().uuid(),
    }).parse(d),
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
  .inputValidator((d: { email_id: string; from_folder_id: string | null; mode: "sender" | "domain" }) =>
    z.object({
      email_id: z.string().uuid(),
      from_folder_id: z.string().uuid().nullable(),
      mode: z.enum(["sender", "domain"]),
    }).parse(d),
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
      .select("id, subject, from_addr, from_name, received_at, snippet")
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
      matches: (rows ?? []) as Array<{
        id: string; subject: string | null; from_addr: string | null;
        from_name: string | null; received_at: string | null; snippet: string | null;
      }>,
      domain: extractDomain(email.from_addr),
    };
  });

export const bulkMoveEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    email_ids: string[];
    to_folder_id: string;
    create_rule?: { field: "domain" | "from"; value: string } | null;
  }) =>
    z.object({
      email_ids: z.array(z.string().uuid()).min(1).max(100),
      to_folder_id: z.string().uuid(),
      create_rule: z
        .object({
          field: z.enum(["domain", "from"]),
          value: z.string().min(1).max(253),
        })
        .nullable()
        .optional(),
    }).parse(d),
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
  .inputValidator((d: { email_id: string }) =>
    z.object({ email_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { classifyParsedEmail } = await import("./sync.server");
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

    const result = await classifyParsedEmail(parsed, context.userId, email.gmail_account_id, { skipGmailLabelMatch: true });

    // Always make sure we have a summary on the row after Reanalyze, even when
    // the classifier (filter/label/domain rule) didn't run the AI summarizer.
    let summary = result.ai_summary || "";
    if (!summary) {
      try {
        const { summarizeEmail } = await import("./ai.server");
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

    // If the classifier didn't pick a folder and the email already has one,
    // keep the current assignment regardless of WHY the classifier abstained
    // (AI no-match, excluded by rule, global override, etc.). Reanalyze should
    // only move emails to a better folder, never silently clear them.
    if (result.folder_id === null && email.folder_id) {
      await supabaseAdmin
        .from("emails")
        .update({ ai_summary: summary || null })
        .eq("id", email.id);
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


    await supabaseAdmin
      .from("emails")
      .update({
        folder_id: result.folder_id,
        classified_by: result.classified_by,
        ai_confidence: result.ai_confidence,
        ai_summary: summary || null,
        classification_reason: result.classification_reason,
        matched_filter_ids: result.matched_filter_ids,
      })
      .eq("id", email.id);

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
        } catch (e) { logError("gmail.reanalyze.label_sync_failed", { email_id: email.id }, e); }
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
    z.object({
      email_id: z.string().uuid(),
      add_override: z.enum(["email", "domain"]).nullable().optional(),
    }).parse(d),
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

    // Recompute raw_labels: add INBOX, drop the moved-from folder label so the
    // local row matches the Gmail mutation below. Without this, the inbox view
    // (which filters on raw_labels @> ['INBOX']) keeps hiding the message.
    const currentLabels = (email.raw_labels ?? []) as string[];
    const nextLabels = Array.from(
      new Set(currentLabels.filter((l) => !fromLabel || l !== fromLabel).concat(["INBOX"])),
    );

    await supabaseAdmin
      .from("emails")
      .update({
        folder_id: null,
        is_archived: false,
        classified_by: "manual_inbox",
        ai_confidence: 1,
        classification_reason: "Moved to Inbox manually",
        matched_filter_ids: [],
        raw_labels: nextLabels,
      })
      .eq("id", email.id);

    // Remove old folder label, ensure INBOX is present.
    try {
      await modifyMessage(
        email.gmail_account_id,
        email.gmail_message_id,
        ["INBOX"],
        fromLabel ? [fromLabel] : [],
      );
    } catch (e) { logError("gmail.inbox.label_sync_failed", {}, e); }

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
      const value = data.add_override === "email"
        ? email.from_addr.toLowerCase()
        : domain;
      if (value) {
        const { data: existing } = await supabaseAdmin
          .from("inbox_overrides")
          .select("id")
          .eq("user_id", context.userId)
          .eq("match_type", data.add_override)
          .eq("value", value)
          .maybeSingle();
        if (!existing) {
          await supabaseAdmin.from("inbox_overrides").insert({
            user_id: context.userId,
            gmail_account_id: email.gmail_account_id,
            match_type: data.add_override,
            value,
          });
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
  .inputValidator((d: { value: string; match_type: "email" | "domain"; reprocess_past?: boolean; gmail_account_id?: string }) =>
    z.object({
      value: z.string().min(1).max(320),
      match_type: z.enum(["email", "domain"]),
      reprocess_past: z.boolean().optional(),
      gmail_account_id: z.string().uuid().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const value = data.value.trim().toLowerCase().replace(/^@/, "");
    if (!value) throw new Error("Empty value");
    let existQ = supabaseAdmin
      .from("inbox_overrides")
      .select("id")
      .eq("user_id", context.userId)
      .eq("match_type", data.match_type)
      .eq("value", value);
    existQ = data.gmail_account_id
      ? existQ.eq("gmail_account_id", data.gmail_account_id)
      : existQ.is("gmail_account_id", null);
    const { data: existing } = await existQ.maybeSingle();
    const already = !!existing;
    if (!already) {
      const { error } = await supabaseAdmin.from("inbox_overrides").insert({
        user_id: context.userId,
        gmail_account_id: data.gmail_account_id ?? null,
        match_type: data.match_type,
        value,
      });
      if (error) throw new Error(error.message);
      // Bust caches across every account this user owns so the new override
      // routes incoming mail immediately.
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
        const folderIds = Array.from(new Set(matches.map((m) => m.folder_id).filter((x): x is string => !!x)));
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
              const oldLabel = m.folder_id ? labelById.get(m.folder_id) : null;
              const currentLabels = ((m as { raw_labels: string[] | null }).raw_labels ?? []) as string[];
              // Reprocess past path: row was filed into a folder (often
              // auto-archived with INBOX stripped). Restore INBOX locally
              // AND in Gmail so the row matches the inbox view filter
              // (raw_labels @> ['INBOX']) just like the runtime
              // inbox_override path in process-message.
              const nextLabels = Array.from(
                new Set(currentLabels.filter((l) => !oldLabel || l !== oldLabel).concat(["INBOX"])),
              );
              await supabaseAdmin
                .from("emails")
                .update({
                  folder_id: null,
                  is_archived: false,
                  classified_by: "inbox_override",
                  classification_reason: reason,
                  matched_filter_ids: [],
                  ai_summary: null,
                  raw_labels: nextLabels,
                })
                .eq("id", m.id);
              try {
                await modifyMessage(
                  m.gmail_account_id,
                  m.gmail_message_id,
                  ["INBOX"],
                  oldLabel ? [oldLabel] : [],
                );
              } catch (e) {
                logError("gmail.reprocess.label_sync_failed", { email_id: m.id }, e);
              }
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

export const stripFolderLabelPast = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { value: string; match_type: "email" | "domain" }) =>
    z.object({
      value: z.string().min(1).max(320),
      match_type: z.enum(["email", "domain"]),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const value = data.value.trim().toLowerCase().replace(/^@/, "");
    if (!value) throw new Error("Empty value");

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

    let stripped_count = 0;
    if (matches.length) {
      const folderIds = Array.from(new Set(matches.map((m) => m.folder_id).filter((x): x is string => !!x)));
      const { data: fs } = await supabaseAdmin
        .from("folders")
        .select("id, gmail_label_id")
        .in("id", folderIds);
      const labelById = new Map((fs ?? []).map((f) => [f.id, f.gmail_label_id]));
      const reason = "Right-click: removed folder label";

      const concurrency = 5;
      let i = 0;
      async function worker() {
        while (i < matches.length) {
          const m = matches[i++];
          try {
            await supabaseAdmin
              .from("emails")
              .update({
                folder_id: null,
                is_archived: !((m.raw_labels ?? []) as string[]).includes("INBOX"),
                classified_by: "manual_strip",
                classification_reason: reason,
                matched_filter_ids: [],
                ai_summary: null,
              })
              .eq("id", m.id);
            const oldLabel = m.folder_id ? labelById.get(m.folder_id) : null;
            if (oldLabel) {
              try {
                await modifyMessage(m.gmail_account_id, m.gmail_message_id, [], [oldLabel]);
              } catch (e) {
                logError("gmail.strip.label_failed", { email_id: m.id }, e);
              }
            }
            stripped_count++;
          } catch (e) {
            logError("gmail.strip.row_failed", { email_id: m.id }, e);
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, matches.length) }, worker));
    }

    return { ok: true, stripped_count };
  });

/**
 * Search Gmail directly and ingest any matching messages we don't already
 * have locally. Used as a fallback when the local search corpus is missing
 * recent or older messages.
 */
export const searchGmailAndIngest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { query: string; account_id?: string }) =>
    z.object({
      query: z.string().min(1).max(200),
      account_id: z.string().uuid().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    // Resolve the gmail accounts to search across.
    const accountIds: string[] = [];
    if (data.account_id) {
      await getOwnedAccount(context.userId, data.account_id);
      accountIds.push(data.account_id);
    } else {
      const { data: accts } = await supabaseAdmin
        .from("gmail_accounts")
        .select("id")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: true });
      for (const a of accts ?? []) accountIds.push(a.id);
      if (accountIds.length === 0) return { ingested: 0, found: 0, reason: "no_account" as const };
    }

    // Build a Gmail query. If it looks like an email address or domain, use
    // `from:` so we hit sender matches across the entire mailbox; otherwise
    // pass the raw text and let Gmail's full-text search work.
    const raw = data.query.trim();
    const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
    const looksLikeDomain = /^@?[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) && !raw.includes(" ");
    // Explicit Gmail-style operator queries (from:/to:) get a "deep" search:
    // page further into older results so old senders aren't capped by the
    // single-page 50-result window.
    // Always page deeply — free-text searches like "rob morris" need to
    // reach older mail, not just the 50 newest Gmail hits.
    const isDeep = true;
    let q: string;
    if (looksLikeEmail) q = `from:${raw}`;
    else if (looksLikeDomain) q = `from:${raw.replace(/^@/, "")}`;
    else q = raw;

    let totalIngested = 0;
    let totalFound = 0;
    let reauthFailures = 0;
    let rateLimited = false;
    const hitGmailMessageIds: string[] = [];

    const isRateLimit = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return /rateLimitExceeded|Quota exceeded|userRateLimitExceeded|429/i.test(msg);
    };

    for (const accountId of accountIds) {
      try {
        // Page Gmail search results modestly. Going wider triggers per-user
        // quota errors; 2x100 covers the vast majority of name searches.
        const PAGE = 100;
        const MAX_PAGES = isDeep ? 2 : 1;
        const hits: Array<{ id: string; threadId: string }> = [];
        let pageToken: string | undefined;
        for (let p = 0; p < MAX_PAGES; p++) {
          try {
            const list = await listMessages(accountId, { q, maxResults: PAGE, pageToken });
            for (const m of list.messages ?? []) hits.push(m);
            pageToken = list.nextPageToken;
            if (!pageToken) break;
          } catch (e) {
            if (isRateLimit(e)) { rateLimited = true; break; }
            throw e;
          }
        }
        if (hits.length === 0) continue;

        // Use only direct Gmail search hits (no thread expansion) so we don't
        // burn Gmail per-minute quota fetching unrelated thread messages.
        const allMessageIds = new Set<string>(hits.map((m) => m.id));

        const idsArr = Array.from(allMessageIds);
        for (const id of idsArr) hitGmailMessageIds.push(id);
        totalFound += idsArr.length;
        const { data: existing } = await supabaseAdmin
          .from("emails")
          .select("gmail_message_id")
          .eq("user_id", context.userId)
          .in("gmail_message_id", idsArr);
        const known = new Set((existing ?? []).map((r) => r.gmail_message_id));
        const todo = idsArr.filter((id) => !known.has(id));

        // Cache folder label → folder_id mapping for this account.
        const { data: folders } = await supabaseAdmin
          .from("folders")
          .select("id, gmail_label_id")
          .eq("user_id", context.userId)
          .eq("gmail_account_id", accountId);
        const labelToFolder = new Map<string, string>();
        for (const f of folders ?? []) {
          if (f.gmail_label_id) labelToFolder.set(f.gmail_label_id, f.id);
        }

        // Load folder_filters for this user so newly-ingested messages
        // honor existing domain / sender / subject rules instead of
        // landing as un-classified gmail_search_ingest rows.
        const folderIds = (folders ?? []).map((f) => f.id);
        type Filter = { id: string; folder_id: string; field: string; op: string; value: string };
        let filters: Filter[] = [];
        if (folderIds.length > 0) {
          const { data: ff } = await supabaseAdmin
            .from("folder_filters")
            .select("id, folder_id, field, op, value")
            .in("folder_id", folderIds);
          filters = (ff ?? []) as Filter[];
        }
        function matchFilters(parsed: {
          from_addr: string; from_name: string; to_addrs: string;
          subject: string; body_text: string; has_attachment: boolean;
        }): { folder_id: string; field: string; value: string } | null {
          for (const f of filters) {
            const v = (f.value || "").toLowerCase();
            const fieldVal = (() => {
              switch (f.field) {
                case "from": return `${parsed.from_addr} ${parsed.from_name}`.toLowerCase();
                case "to": return (parsed.to_addrs || "").toLowerCase();
                case "subject": return (parsed.subject || "").toLowerCase();
                case "body": return (parsed.body_text || "").toLowerCase();
                case "domain": return (parsed.from_addr.split("@")[1] || "").toLowerCase();
                case "has_attachment": return parsed.has_attachment ? "true" : "false";
                default: return "";
              }
            })();
            const hit = (() => {
              switch (f.op) {
                case "contains": return fieldVal.includes(v);
                case "equals": return fieldVal === v;
                case "regex":
                  try { return new RegExp(f.value, "i").test(fieldVal); } catch { return false; }
                default: return false;
              }
            })();
            if (hit) return { folder_id: f.folder_id, field: f.field, value: v };
          }
          return null;
        }

        // Low concurrency + stop early on rate-limit to stay within Gmail's
        // per-minute quota (~250 calls/user/min, shared with sync).
        const CONCURRENCY = 3;
        let i = 0;
        let stop = false;
        async function worker() {
          while (i < todo.length && !stop) {
            const id = todo[i++];
            try {
              const raw = await getMessage(accountId, id);
              const p = parseMessage(raw);
              let folder_id: string | null = null;
              let classified_by: string = "gmail_search_ingest";
              let classification_reason: string | null = "Pulled from Gmail via search";
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
                const m = matchFilters({
                  from_addr: p.from_addr ?? "",
                  from_name: p.from_name ?? "",
                  to_addrs: p.to_addrs ?? "",
                  subject: p.subject ?? "",
                  body_text: p.body_text ?? "",
                  has_attachment: !!p.has_attachment,
                });
                if (m) {
                  folder_id = m.folder_id;
                  classified_by = m.field === "domain" ? "domain_rule" : "filter";
                  classification_reason =
                    m.field === "domain"
                      ? `Domain rule: ${m.value}`
                      : `Folder rule: ${m.field} ${m.value}`;
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
                  });
                }
              }
              else logError("gmail.search_ingest.insert_failed", { account_id: accountId, gmail_message_id: id }, { message: error });
            } catch (e) {
              if (isRateLimit(e)) {
                rateLimited = true;
                stop = true;
                break;
              }
              logError("gmail.search_ingest.one_failed", { account_id: accountId, gmail_message_id: id }, e);
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/missing OAuth tokens|reauthorize|invalid_grant/i.test(msg)) {
          reauthFailures++;
        }
        if (isRateLimit(e)) rateLimited = true;
        logError("gmail.search_ingest.account_failed", { account_id: accountId }, e);
      }
    }

    if (reauthFailures > 0 && reauthFailures === accountIds.length) {
      return { ingested: 0, found: 0, reason: "reauth_required" as const, hit_gmail_message_ids: [] as string[] };
    }
    return {
      ingested: totalIngested,
      found: totalFound,
      hit_gmail_message_ids: hitGmailMessageIds,
      ...(rateLimited ? { reason: "rate_limited" as const } : {}),
    };
  });





export const listPubsubEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      event_type: z.enum(["push", "push_empty", "poll", "watch_renew", "watch_rearm_auto", "gmail_api_error", "webhook_test"]).optional(),
      only_errors: z.boolean().optional(),
      limit: z.number().min(1).max(500).optional(),
      account_id: z.string().uuid().optional(),
    }).parse(input ?? {})
  )
  .handler(async ({ data, context }) => {
    const limit = data.limit ?? 100;

    // Scope all diagnostics to the caller's own Gmail accounts to avoid
    // leaking other users' email addresses / sync metadata. When account_id
    // is supplied, narrow to that one account.
    let acctQ = supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", context.userId);
    if (data.account_id) acctQ = acctQ.eq("id", data.account_id);
    const { data: myAccounts } = await acctQ;
    const myEmails = (myAccounts ?? []).map((a) => a.email_address).filter(Boolean) as string[];
    const myAccountIds = (myAccounts ?? []).map((a) => a.id);

    // If the user has no connected accounts, return an empty diagnostics shape.
    if (myEmails.length === 0) {
      const host = getRequestHost();
      return {
        events: [],
        stats: {
          push24: 0, poll24: 0, renew24: 0, accounts24: 0, synced24: 0,
          errors24: 0, gmailErrors24: 0, pushEmpty24: 0, pushUnmatched24: 0,
          lastReceivedAt: null, lastPollAt: null, lastPushAt: null,
        },
        diagnostics: {
          lastPush: null,
          lastWatchRenew: null,
          lastWebhookTest: null,
          webhookUrl: `https://${host}/api/public/gmail-webhook`,
          pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC ?? null,
          stuckJobs: [],
        },
      };
    }

    let q = supabaseAdmin
      .from("pubsub_events")
      .select("id, received_at, event_type, email_address, history_id, accounts_matched, synced_count, error, message_id, publish_time, subscription, payload, details")
      .in("email_address", myEmails)
      .order("received_at", { ascending: false })
      .limit(limit);
    if (data.event_type) q = q.eq("event_type", data.event_type);
    if (data.only_errors) q = q.not("error", "is", null);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: agg } = await supabaseAdmin
      .from("pubsub_events")
      .select("event_type, accounts_matched, synced_count, error, received_at")
      .in("email_address", myEmails)
      .gte("received_at", since)
      .limit(5000);

    let push24 = 0, poll24 = 0, renew24 = 0, accounts24 = 0, synced24 = 0, errors24 = 0, gmailErrors24 = 0, pushEmpty24 = 0, pushUnmatched24 = 0;
    let lastPollAt: string | null = null;
    let lastPushAt: string | null = null;
    for (const r of agg ?? []) {
      if (r.event_type === "push") {
        push24++;
        if (!lastPushAt || r.received_at > lastPushAt) lastPushAt = r.received_at;
        if ((r.accounts_matched ?? 0) === 0) pushUnmatched24++;
      } else if (r.event_type === "push_empty") {
        pushEmpty24++;
      } else if (r.event_type === "poll") {
        poll24++;
        if (!lastPollAt || r.received_at > lastPollAt) lastPollAt = r.received_at;
      } else if (r.event_type === "watch_renew" || r.event_type === "watch_rearm_auto") {
        renew24++;
      } else if (r.event_type === "gmail_api_error") {
        gmailErrors24++;
      }
      accounts24 += r.accounts_matched ?? 0;
      synced24 += r.synced_count ?? 0;
      if (r.error) errors24++;
    }

    // Most recent REAL push from Google (synthetic webhook_test rows are
    // excluded — they're app-side tests, not proof of GCP delivery).
    const cols = "id, received_at, event_type, email_address, history_id, accounts_matched, synced_count, error, message_id, publish_time, subscription, payload, details";
    const { data: anyPushRows } = await supabaseAdmin
      .from("pubsub_events")
      .select(cols)
      .in("email_address", myEmails)
      .in("event_type", ["push", "push_empty"])
      .order("received_at", { ascending: false })
      .limit(1);
    const lastPush: any = anyPushRows?.[0] ?? null;

    // Most recent webhook self-test (separate from real pushes).
    const { data: lastTestRows } = await supabaseAdmin
      .from("pubsub_events")
      .select(cols)
      .in("email_address", myEmails)
      .eq("event_type", "webhook_test")
      .order("received_at", { ascending: false })
      .limit(1);
    const lastWebhookTest = lastTestRows?.[0] ?? null;

    const { data: lastRenewRows } = await supabaseAdmin
      .from("pubsub_events")
      .select("received_at, details, email_address, history_id")
      .in("email_address", myEmails)
      .in("event_type", ["watch_renew", "watch_rearm_auto"])
      .order("received_at", { ascending: false })
      .limit(1);
    const lastWatchRenew = lastRenewRows?.[0] ?? null;

    const host = getRequestHost();
    const webhookUrl = `https://${host}/api/public/gmail-webhook`;

    // Stuck jobs: status='running' for > 2 minutes (worker died mid-processing).
    const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuckJobs } = await supabaseAdmin
      .from("message_jobs")
      .select("id, gmail_message_id, gmail_account_id, attempt, locked_at, from_addr, subject")
      .in("gmail_account_id", myAccountIds)
      .eq("status", "running")
      .lt("locked_at", stuckCutoff)
      .order("locked_at", { ascending: true })
      .limit(25);

    // Pending jobs count + oldest pending — surfaces "push fired, processing backlogged"
    const { count: pendingCount } = await supabaseAdmin
      .from("message_jobs")
      .select("id", { count: "exact", head: true })
      .in("gmail_account_id", myAccountIds)
      .eq("status", "pending");
    const { data: oldestPendingRow } = await supabaseAdmin
      .from("message_jobs")
      .select("created_at")
      .in("gmail_account_id", myAccountIds)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();


    return {
      events: rows ?? [],
      stats: {
        push24, poll24, renew24, accounts24, synced24, errors24, gmailErrors24,
        pushEmpty24, pushUnmatched24,
        lastReceivedAt: rows?.[0]?.received_at ?? null,
        lastPollAt,
        lastPushAt,
      },
      diagnostics: {
        lastPush,
        lastWatchRenew,
        lastWebhookTest,
        webhookUrl,
        pubsubTopic: process.env.GMAIL_PUBSUB_TOPIC ?? null,
        stuckJobs: stuckJobs ?? [],
        pendingJobs: pendingCount ?? 0,
        oldestPendingAt: oldestPendingRow?.created_at ?? null,
      },
    };
  });




/** Re-pull the current Gmail label state for a single message and reconcile our row. */
export const resyncMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    const labels = await getMessageLabels(email.gmail_account_id, email.gmail_message_id);
    if (labels === null) {
      await supabaseAdmin.from("emails").delete().eq("id", data.id);
      return { deleted: true };
    }
    if (labels.includes("TRASH")) {
      await supabaseAdmin.from("emails").delete().eq("id", data.id);
      return { deleted: true };
    }
    const inInbox = labels.includes("INBOX");
    const unread = labels.includes("UNREAD");
    await supabaseAdmin.from("emails").update({
      raw_labels: labels,
      is_archived: !inInbox,
      is_read: !unread,
    }).eq("id", data.id);
    return { in_inbox: inInbox, unread, labels };
  });

/**
 * Self-heal the Inbox view by asking Gmail which of the user's locally-
 * "in inbox" messages are actually still in INBOX. Any local row whose
 * gmail_message_id is missing from Gmail's current top-N inbox slice has
 * been archived (or deleted) externally and is reconciled in place.
 *
 * Costs ONE Gmail list call + at most a handful of per-message label
 * fetches for the drifted ids, regardless of how many emails are shown.
 */
export const reconcileInboxFromGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { gmail_account_id: string }) =>
    z.object({ gmail_account_id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.gmail_account_id);

    // Fetch the locally-inbox rows for this account (newest first). Cap
    // matches the Gmail INBOX slice we pull below so we never miss a row
    // by paging past it.
    const LIMIT = 500;
    const { data: localRows } = await supabaseAdmin
      .from("emails")
      .select("id, gmail_message_id, received_at")
      .eq("gmail_account_id", data.gmail_account_id)
      .eq("user_id", context.userId)
      .eq("is_archived", false)
      .contains("raw_labels", ["INBOX"])
      .order("received_at", { ascending: false, nullsFirst: false })
      .limit(LIMIT);

    const rows = (localRows ?? []) as Array<{ id: string; gmail_message_id: string; received_at: string | null }>;
    if (rows.length === 0) return { checked: 0, reconciled: 0, deleted: 0 };

    // Pull the current Gmail INBOX slice in one call. maxResults caps at 500.
    const gmailInbox = new Set<string>();
    try {
      const list = await listMessages(data.gmail_account_id, {
        labelIds: ["INBOX"],
        maxResults: 500,
      });
      for (const m of list.messages ?? []) gmailInbox.add(m.id);
    } catch (e) {
      logError(
        "reconcile.inbox_list_failed",
        { account_id: data.gmail_account_id, user_id: context.userId },
        e,
      );
      return { checked: 0, reconciled: 0, deleted: 0, error: (e as Error).message };
    }

    // Anchor: only consider local rows whose received_at is at or newer
    // than the oldest message in the Gmail INBOX slice we just pulled.
    // Older rows might genuinely still be in inbox but past our 500-row
    // window. The deep reconcile path (cron) covers that.
    const drifted = rows.filter((r) => !gmailInbox.has(r.gmail_message_id));
    if (drifted.length === 0) return { checked: rows.length, reconciled: 0, deleted: 0 };

    // Cap per-call repair work so a one-off divergence can't hammer the
    // Gmail API on every poll. The cron reconcile mops up the rest.
    const MAX_REPAIR = 25;
    let reconciled = 0;
    let deleted = 0;
    for (const r of drifted.slice(0, MAX_REPAIR)) {
      try {
        const labels = await getMessageLabels(data.gmail_account_id, r.gmail_message_id);
        if (labels === null || labels.includes("TRASH")) {
          await supabaseAdmin.from("emails").delete().eq("id", r.id);
          deleted++;
          continue;
        }
        const inInbox = labels.includes("INBOX");
        const unread = labels.includes("UNREAD");
        await supabaseAdmin.from("emails").update({
          raw_labels: labels,
          is_archived: !inInbox,
          is_read: !unread,
        }).eq("id", r.id);
        if (!inInbox) reconciled++;
      } catch (e) {
        logError(
          "reconcile.message_repair_failed",
          { account_id: data.gmail_account_id, gmail_message_id: r.gmail_message_id },
          e,
        );
      }
    }
    return { checked: rows.length, drifted: drifted.length, reconciled, deleted };
  });



/**
 * Surface push→ack and push→visible latency percentiles over the last N
 * hours, scoped to the caller's mailboxes. Backed by a SECURITY DEFINER
 * SQL function so we can compute percentile_cont() in one roundtrip
 * instead of paginating raw rows back to JS.
 */
export const getSyncLatencyStats = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      lookback_hours: z.number().int().min(1).max(24 * 7).optional(),
      account_id: z.string().uuid().optional(),
    }).parse(d ?? {}),
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
    return stats ?? {
      push_to_ack: { count: 0, p50: null, p95: null, p99: null },
      push_to_visible: { count: 0, p50: null, p95: null, p99: null },
      since: new Date(Date.now() - (data.lookback_hours ?? 24) * 3600_000).toISOString(),
    };
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
    } catch (e: any) {
      return {
        url,
        ok: false,
        status: 0,
        elapsed_ms: Date.now() - started,
        topic_set: !!process.env.GMAIL_PUBSUB_TOPIC,
        mode,
        account_email,
        error: e?.message ?? String(e),
      };
    }
  });


/** List processing jobs (queue + DLQ) for the current user. */
export const listMessageJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({
      status: z.enum(["pending", "running", "dlq", "all"]).optional(),
      limit: z.number().min(1).max(500).optional(),
      account_id: z.string().uuid().optional(),
    }).parse(input ?? {})
  )
  .handler(async ({ data, context }) => {
    const limit = data.limit ?? 100;
    let q = supabaseAdmin
      .from("message_jobs")
      .select("id, gmail_account_id, gmail_message_id, attempt, status, next_run_at, last_error, from_addr, subject, created_at, updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (data.status && data.status !== "all") q = q.eq("status", data.status);
    if (data.account_id) q = q.eq("gmail_account_id", data.account_id);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    let aggQ = supabaseAdmin
      .from("message_jobs")
      .select("status")
      .eq("user_id", context.userId);
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
    z.object({ limit: z.number().min(1).max(100).optional() }).parse(input ?? {})
  )
  .handler(async ({ data }) => {
    return await runMessageJobs(data.limit ?? 25);
  });

/** Re-enqueue a single Gmail message id for the current user's connected accounts. */
export const enqueueGmailMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { gmail_account_id: string; gmail_message_id: string }) =>
    z.object({
      gmail_account_id: z.string().uuid(),
      gmail_message_id: z.string().min(1).max(64),
    }).parse(d)
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
  .inputValidator((d: {
    folder_id: string;
    field: "from" | "domain" | "subject";
    value: string;
    op?: "contains" | "equals" | "starts_with";
  }) =>
    z.object({
      folder_id: z.string().uuid(),
      field: z.enum(["from", "domain", "subject"]),
      value: z.string().min(1).max(998),
      op: z.enum(["contains", "equals", "starts_with"]).optional(),
    }).parse(d),
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
  .inputValidator((d: {
    account_id: string;
    field: "from" | "domain" | "subject";
    op: "contains" | "equals" | "starts_with";
    value: string;
  }) =>
    z.object({
      account_id: z.string().uuid(),
      field: z.enum(["from", "domain", "subject"]),
      op: z.enum(["contains", "equals", "starts_with"]),
      value: z.string().min(1).max(998),
    }).parse(d),
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
  .inputValidator((d: {
    account_id: string;
    to_folder_id: string;
    field: "from" | "domain" | "subject";
    op: "contains" | "equals" | "starts_with";
    value: string;
    archive?: boolean;
  }) =>
    z.object({
      account_id: z.string().uuid(),
      to_folder_id: z.string().uuid(),
      field: z.enum(["from", "domain", "subject"]),
      op: z.enum(["contains", "equals", "starts_with"]),
      value: z.string().min(1).max(998),
      archive: z.boolean().optional().default(false),
    }).parse(d),
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
    const applyRulePredicate = <T extends ReturnType<typeof supabaseAdmin.from>>(qb: any) => {
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
      const targetRows = (archRows ?? []) as Array<{ id: string; gmail_message_id: string | null; raw_labels: string[] | null }>;
      const gmailIds = targetRows.map((r) => r.gmail_message_id).filter(Boolean) as string[];
      if (gmailIds.length > 0) {
        try {
          await batchModifyMessages(data.account_id, gmailIds, [], ["INBOX"]);
        } catch (e) {
          logError("gmail.filter_rule.archive_past_failed", { account_id: data.account_id, folder_id: data.to_folder_id }, e);
        }
      }
      await Promise.all(targetRows.map((row) => supabaseAdmin
        .from("emails")
        .update({ is_archived: true, raw_labels: removeLabelsFromCurrent(row.raw_labels, ["INBOX"]) })
        .eq("id", row.id)));
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
    z.object({
      folderId: z.string().uuid(),
      behavior: z.enum(["mark_read", "archive", "star"]),
    }).parse(input),
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
      logError("gmail.retroactive.batch_modify_failed", { account_id: folder.gmail_account_id, folder_id: data.folderId }, e);
    }

    // DB side.
    const patch: { is_read?: boolean; is_archived?: boolean; raw_labels?: string[] } = {};
    if (data.behavior === "mark_read") patch.is_read = true;
    else if (data.behavior === "archive") patch.is_archived = true;
    if (Object.keys(patch).length > 0) {
      if (data.behavior === "archive") {
        await Promise.all(rows.map((row) => supabaseAdmin
          .from("emails")
          .update({ ...patch, raw_labels: removeLabelsFromCurrent(row.raw_labels, ["INBOX"]) })
          .eq("id", row.id)));
      } else {
        await supabaseAdmin
          .from("emails")
          .update(patch)
          .in("id", rows.map((r) => r.id));
      }
    }

    return { count: rows.length };
  });


// ─── Bulk actions on the "No rules" view ────────────────────────────────────

export const reclassifyEmails = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { email_ids: string[] }) =>
    z.object({ email_ids: z.array(z.string().uuid()).min(1).max(100) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { classifyParsedEmail } = await import("./sync.server");
    const { data: rows } = await supabaseAdmin
      .from("emails_decrypted")
      .select("id, user_id, gmail_account_id, gmail_message_id, folder_id, from_addr, from_name, to_addrs, subject, snippet, body_text, body_html, has_attachment, received_at, raw_labels")
      .in("id", data.email_ids);
    if (!rows) return { routed: 0, unchanged: 0, failed: 0 };

    let routed = 0;
    let unchanged = 0;
    let failed = 0;

    for (const email of rows) {
      if (email.user_id !== context.userId) { failed++; continue; }
      if (!email.id || !email.gmail_account_id) { failed++; continue; }
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
        const result = await classifyParsedEmail(parsed, context.userId, email.gmail_account_id, { skipGmailLabelMatch: true });
        if (result.folder_id && result.folder_id !== email.folder_id) {
          await supabaseAdmin
            .from("emails")
            .update({
              folder_id: result.folder_id,
              classified_by: result.classified_by,
              ai_confidence: result.ai_confidence,
              classification_reason: result.classification_reason,
              matched_filter_ids: result.matched_filter_ids,
            })
            .eq("id", email.id);
          routed++;
        } else {
          unchanged++;
        }
      } catch (e) {
        logError("gmail.reclassify.iter_failed", { email_id: email.id, user_id: context.userId }, e);
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
      .select("user_id, from_addr, from_name, subject, snippet")
      .in("id", data.email_ids)
      .limit(50);
    const safe = (rows ?? []).filter((r) => r.user_id === context.userId);
    if (safe.length === 0) throw new Error("No emails found");
    const suggestion = await suggestFolderFromEmails(safe.map((r) => ({
      from_addr: r.from_addr, from_name: r.from_name, subject: r.subject, snippet: r.snippet,
    })));
    return suggestion;
  });

export const createFolderAndAssign = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    account_id: string;
    name: string;
    color: string;
    ai_rule: string;
    filter?: { field: string; op: string; value: string } | null;
    email_ids: string[];
  }) => z.object({
    account_id: z.string().uuid(),
    name: z.string().min(1).max(80),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    ai_rule: z.string().max(500),
    filter: z.object({
      field: z.string().min(1).max(40),
      op: z.string().min(1).max(20),
      value: z.string().min(1).max(200),
    }).nullable().optional(),
    email_ids: z.array(z.string().uuid()).max(100),
  }).parse(d))
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
      await supabaseAdmin
        .from("emails")
        .update({
          folder_id: folder.id,
          classified_by: "manual_move",
          ai_confidence: 1,
          classification_reason: `Moved into new folder "${data.name}"`,
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
    z.object({
      folder_id: z.string().uuid(),
      auto_relearn: z.boolean(),
      threshold: z.number().int().min(1).max(1000).optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: { auto_relearn: boolean; relearn_threshold?: number } = { auto_relearn: data.auto_relearn };
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
    z.object({
      folder_id: z.string().uuid(),
      months: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]).optional(),
    }).parse(d),
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
        ingested: 0, found: 0, queries_run: 0, skipped_regex: skippedRegex,
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

    outer:
    for (const q of queries) {
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
            if (totalIngested >= HARD_INGEST_CAP) { truncated = true; return; }
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
                    classification_reason = result.filter.field === "domain"
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
              }
              else logError("gmail.scan_folder.insert_failed", { account_id: accountId, gmail_message_id: id }, { message: error });
            } catch (e) {
              logError("gmail.scan_folder.one_failed", { account_id: accountId, gmail_message_id: id }, e);
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
        if (totalIngested >= HARD_INGEST_CAP) { truncated = true; break outer; }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/missing OAuth tokens|reauthorize|invalid_grant/i.test(msg)) {
          reauthFailed = true;
          break;
        }
        logError("gmail.scan_folder.query_failed", { account_id: accountId, folder_id: folder.id, q }, e);
      }
    }

    if (reauthFailed && totalIngested === 0) {
      return {
        ok: false as const,
        ingested: 0, found: totalFound, queries_run: queriesRun,
        skipped_regex: skippedRegex, truncated: false,
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
