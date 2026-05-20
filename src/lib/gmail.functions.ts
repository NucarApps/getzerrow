import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { backfillRecent, syncSinceHistory, learnFromLinkedLabel, reconcileLocalInbox } from "./sync.server";
import {
  listLabels,
  createLabel,
  modifyMessage,
  trashMessage,
  sendMessage,
  ensureWatch,
  stopWatch,
} from "./gmail.server";
import { suggestReply, suggestRuleUpdates } from "./ai.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { signState, buildAuthorizeUrl, getRedirectUri } from "./google-oauth.server";
import { getRequestHost } from "@tanstack/react-start/server";

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
  const { data, error } = await supabaseAdmin
    .from("emails")
    .select("gmail_message_id, gmail_account_id, user_id, thread_id, from_addr, subject, body_text, from_name")
    .eq("id", emailId)
    .single();
  if (error || !data) throw new Error("Email not found");
  if (data.user_id !== userId) throw new Error("Not authorized");
  return data;
}

export const listMyGmailAccounts = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address, history_id, watch_expiration, last_poll_at, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true });
    return { accounts: data ?? [] };
  });

export const startConnectGmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const host = getRequestHost();
    const origin = `https://${host}`;
    const redirectUri = getRedirectUri(origin);
    const state = signState(context.userId);
    return { url: buildAuthorizeUrl(redirectUri, state) };
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
    const { data: account, error } = await supabaseAdmin
      .from("gmail_accounts")
      .upsert(
        {
          user_id: context.userId,
          email_address: data.email_address,
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          token_expires_at: expiresAt,
        },
        { onConflict: "user_id,email_address" }
      )
      .select("id")
      .single();
    if (error || !account) throw new Error(`Failed to save account: ${error?.message}`);

    try {
      const watch = await ensureWatch(account.id, null);
      if (watch) {
        await supabaseAdmin.from("gmail_accounts").update({
          history_id: watch.historyId,
          watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
        }).eq("id", account.id);
      }
    } catch (e) {
      console.error("ensureWatch failed during auto-connect", e);
    }

    try {
      await backfillRecent(account.id, context.userId, 30);
    } catch (e) {
      console.error("backfill failed during auto-connect", e);
    }

    return { account_id: account.id };
  });

export const disconnectGmailAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) => z.object({ account_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    try { await stopWatch(data.account_id); } catch (e) { console.error("stopWatch failed", e); }
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
  .inputValidator((d: { account_id: string; name: string }) =>
    z.object({ account_id: z.string().uuid(), name: z.string().min(1).max(100) }).parse(d)
  )
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const labels = await listLabels(data.account_id);
    const existing = labels.labels?.find((l) => l.name === `Zerrow/${data.name}`);
    if (existing) return { id: existing.id };
    const created = await createLabel(data.account_id, `Zerrow/${data.name}`);
    return { id: created.id };
  });

export const learnFolderFromLabel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { folder_id: string }) => z.object({ folder_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    return learnFromLinkedLabel(data.folder_id, context.userId);
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
      .select("id, user_id")
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
        .update({ folder_id: data.to_folder_id, classified_by: "domain_rule", ai_confidence: 1 })
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
              console.error("reassign label modify failed", e);
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
      if (mirrored.length > 0) {
        await supabaseAdmin.from("folder_examples").insert(mirrored);
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

export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) => z.object({ account_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const histResult = await syncSinceHistory(data.account_id);
    const recon = await reconcileLocalInbox(data.account_id, 100);
    return { ...histResult, reconciled: recon };
  });

export const renewGmailWatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { account_id: string }) => z.object({ account_id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await getOwnedAccount(context.userId, data.account_id);
    const { data: acc } = await supabaseAdmin
      .from("gmail_accounts")
      .select("watch_expiration")
      .eq("id", data.account_id)
      .single();
    // Force renewal by passing null
    const watch = await ensureWatch(data.account_id, null);
    if (!watch) throw new Error("GMAIL_PUBSUB_TOPIC is not configured");
    await supabaseAdmin.from("gmail_accounts").update({
      history_id: watch.historyId,
      watch_expiration: new Date(parseInt(watch.expiration, 10)).toISOString(),
    }).eq("id", data.account_id);
    return { expiration: watch.expiration };
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
    } catch (e) { console.error(e); }
    await supabaseAdmin.from("emails").update({ is_read: data.read }).eq("id", data.id);
    return { ok: true };
  });

export const archiveEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    try { await modifyMessage(email.gmail_account_id, email.gmail_message_id, [], ["INBOX"]); } catch (e) { console.error(e); }
    await supabaseAdmin.from("emails").update({ is_archived: true }).eq("id", data.id);
    return { ok: true };
  });

export const trashEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const email = await getEmailAccount(context.userId, data.id);
    try { await trashMessage(email.gmail_account_id, email.gmail_message_id); } catch (e) { console.error(e); }
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
    await supabaseAdmin.from("reply_drafts").insert({ email_id: data.id, user_id: context.userId, draft_text: draft });
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
