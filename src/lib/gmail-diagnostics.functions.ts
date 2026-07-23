// Operator-facing diagnostics + manual-recovery server functions.
// Extracted from gmail.functions.ts to keep that file focused on
// user-facing mailbox ops (move/archive/reply/etc.).
//
// Surface area:
//   listFolderHistory     — emails belonging to a folder, paginated
//   listPubsubEvents      — push/poll/renew log + 24h stats + diagnostics
//   resyncMessage         — re-pull Gmail label state for one row
//   getSyncLatencyStats   — p50/p95/p99 push-to-visible latency
//   pingPubsubWebhook     — synthetic webhook self-test
//   listMessageJobs       — queue + DLQ list with counts
//   retryJob              — re-run a pending/DLQ job
//   runJobsNow            — drain N jobs immediately
//   enqueueGmailMessage   — re-enqueue a single message id
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getRequestHost } from "@tanstack/react-start/server";
import { getMessageLabels } from "./gmail.server";
import { runMessageJobs, retryMessageJob, enqueueMessageJob } from "./sync.server";
import { getEmailAccount } from "./gmail-helpers.server";
import { reconcileLabelsToPatch } from "@/lib/sync/label-merge";
import { getEmailListFieldsDecrypted } from "@/lib/sync/encrypted-reader";

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
    // subject/from_name/ai_summary/snippet are encrypted at rest (*_enc);
    // select only the plaintext columns here and decrypt the sensitive
    // fields via the shared RPC helper.
    const { data: rows } = await supabaseAdmin
      .from("emails")
      .select("id, from_addr, received_at, classified_by, ai_confidence")
      .eq("user_id", context.userId)
      .eq("folder_id", data.folder_id)
      .order("received_at", { ascending: false })
      .range(offset, offset + limit);
    const base = rows ?? [];
    const { rows: decrypted } = await getEmailListFieldsDecrypted(base.map((r) => r.id));
    const byId = new Map(decrypted.map((f) => [f.id, f]));
    const all = base.map((r) => {
      const f = byId.get(r.id);
      return {
        id: r.id,
        from_addr: r.from_addr,
        from_name: f?.from_name ?? null,
        received_at: r.received_at,
        classified_by: r.classified_by,
        ai_confidence: r.ai_confidence,
        ai_summary: f?.ai_summary ?? null,
        subject: f?.subject ?? null,
        snippet: f?.snippet ?? null,
      };
    });
    const has_more = all.length > limit;
    return { emails: has_more ? all.slice(0, limit) : all, has_more, next_offset: offset + limit };
  });

export const listPubsubEvents = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        event_type: z
          .enum([
            "push",
            "push_empty",
            "poll",
            "watch_renew",
            "watch_rearm_auto",
            "gmail_api_error",
            "webhook_test",
          ])
          .optional(),
        only_errors: z.boolean().optional(),
        limit: z.number().min(1).max(500).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const limit = data.limit ?? 100;

    // Scope all diagnostics to the caller's own Gmail accounts to avoid
    // leaking other users' email addresses / sync metadata.
    const { data: myAccounts } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address")
      .eq("user_id", context.userId);
    const myEmails = (myAccounts ?? []).map((a) => a.email_address).filter(Boolean) as string[];
    const myAccountIds = (myAccounts ?? []).map((a) => a.id);

    if (myEmails.length === 0) {
      const host = getRequestHost();
      return {
        events: [],
        stats: {
          push24: 0,
          poll24: 0,
          renew24: 0,
          accounts24: 0,
          synced24: 0,
          errors24: 0,
          gmailErrors24: 0,
          pushEmpty24: 0,
          pushUnmatched24: 0,
          lastReceivedAt: null,
          lastPollAt: null,
          lastPushAt: null,
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
      .select(
        "id, received_at, event_type, email_address, history_id, accounts_matched, synced_count, error, message_id, publish_time, subscription, payload, details",
      )
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

    let push24 = 0,
      poll24 = 0,
      renew24 = 0,
      accounts24 = 0,
      synced24 = 0,
      errors24 = 0,
      gmailErrors24 = 0,
      pushEmpty24 = 0,
      pushUnmatched24 = 0;
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

    // Synthetic webhook_test rows are excluded — they're app-side tests,
    // not proof of GCP delivery.
    const cols =
      "id, received_at, event_type, email_address, history_id, accounts_matched, synced_count, error, message_id, publish_time, subscription, payload, details";
    const { data: anyPushRows } = await supabaseAdmin
      .from("pubsub_events")
      .select(cols)
      .in("email_address", myEmails)
      .in("event_type", ["push", "push_empty"])
      .order("received_at", { ascending: false })
      .limit(1);
    const lastPush = anyPushRows?.[0] ?? null;

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

    // status='running' for > 2 minutes ⇒ worker died mid-processing.
    const stuckCutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuckJobs } = await supabaseAdmin
      .from("message_jobs")
      .select("id, gmail_message_id, gmail_account_id, attempt, locked_at, from_addr, subject")
      .in("gmail_account_id", myAccountIds)
      .eq("status", "running")
      .lt("locked_at", stuckCutoff)
      .order("locked_at", { ascending: true })
      .limit(25);

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
        push24,
        poll24,
        renew24,
        accounts24,
        synced24,
        errors24,
        gmailErrors24,
        pushEmpty24,
        pushUnmatched24,
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
    const rec = reconcileLabelsToPatch(labels);
    if (rec.delete) {
      await supabaseAdmin.from("emails").delete().eq("id", data.id);
      return { deleted: true };
    }
    await supabaseAdmin.from("emails").update(rec.patch).eq("id", data.id);
    return { in_inbox: rec.inInbox, unread: rec.unread, labels };
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
    z
      .object({
        lookback_hours: z
          .number()
          .int()
          .min(1)
          .max(24 * 7)
          .optional(),
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
        args: { p_user_id: string; p_lookback_hours: number },
      ) => Promise<{ data: LatencyStats | null; error: { message: string } | null }>;
    };
    const { data: stats, error } = await (supabaseAdmin as unknown as LatencyRpc).rpc(
      "get_sync_latency_stats",
      { p_user_id: context.userId, p_lookback_hours: data.lookback_hours ?? 24 },
    );
    if (error) {
      console.error("get_sync_latency_stats RPC failed", error.message);
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
        error: (e as Error)?.message ?? String(e),
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
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const { data: agg } = await supabaseAdmin
      .from("message_jobs")
      .select("status")
      .eq("user_id", context.userId);
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
