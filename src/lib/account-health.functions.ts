// Server functions for the per-account health card in Settings.
// - getAccountHealth: aggregate poll/push/watch/queue stats per Gmail account.
// - retryDlqJobs: bulk re-queue DLQ rows for a single account.
// - retryDlqJob / deleteDlqJob: per-row drawer actions.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export type AccountHealth = {
  accountId: string;
  email: string;
  lastPollAt: string | null;
  lastPushAt: string | null;
  watchExpiresAt: string | null;
  pending: number;
  running: number;
  dlq: number;
  lastError: string | null;
  needsReconnect: boolean;
  lastOauthError: string | null;
};

export const getAccountHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ accounts: AccountHealth[] }> => {
    const { userId } = context;

    const { data: accounts } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id, email_address, last_poll_at, watch_expiration, needs_reconnect, last_oauth_error")
      .eq("user_id", userId);


    const result: AccountHealth[] = [];
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    for (const a of accounts ?? []) {
      // Counts by status — three small count() queries beat a single GROUP BY
      // in the supabase-js builder and are still fast on a per-user slice.
      const [pendingRes, runningRes, dlqRes, pushRes, errorRes] = await Promise.all([
        supabaseAdmin
          .from("message_jobs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("gmail_account_id", a.id)
          .eq("status", "pending"),
        supabaseAdmin
          .from("message_jobs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("gmail_account_id", a.id)
          .eq("status", "running"),
        supabaseAdmin
          .from("message_jobs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("gmail_account_id", a.id)
          .eq("status", "dlq"),
        supabaseAdmin
          .from("pubsub_events")
          .select("received_at")
          .eq("email_address", a.email_address)
          .eq("event_type", "push")
          .order("received_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabaseAdmin
          .from("message_jobs")
          .select("last_error, updated_at")
          .eq("user_id", userId)
          .eq("gmail_account_id", a.id)
          .not("last_error", "is", null)
          .gte("updated_at", oneHourAgo)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      result.push({
        accountId: a.id,
        email: a.email_address,
        lastPollAt: a.last_poll_at,
        lastPushAt: pushRes.data?.received_at ?? null,
        watchExpiresAt: a.watch_expiration,
        pending: pendingRes.count ?? 0,
        running: runningRes.count ?? 0,
        dlq: dlqRes.count ?? 0,
        lastError: errorRes.data?.last_error ?? null,
        needsReconnect: a.needs_reconnect ?? false,
        lastOauthError: a.last_oauth_error ?? null,
      });
    }

    return { accounts: result };
  });

export type DlqRow = {
  id: string;
  gmailMessageId: string;
  fromAddr: string | null;
  subject: string | null;
  attempt: number;
  lastError: string | null;
  updatedAt: string;
};

export const listDlqJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ account_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<{ rows: DlqRow[] }> => {
    const { data: rows } = await supabaseAdmin
      .from("message_jobs")
      .select("id, gmail_message_id, from_addr, subject, attempt, last_error, updated_at")
      .eq("user_id", context.userId)
      .eq("gmail_account_id", data.account_id)
      .eq("status", "dlq")
      .order("updated_at", { ascending: false })
      .limit(200);

    return {
      rows: (rows ?? []).map((r) => ({
        id: r.id,
        gmailMessageId: r.gmail_message_id,
        fromAddr: r.from_addr,
        subject: r.subject,
        attempt: r.attempt,
        lastError: r.last_error,
        updatedAt: r.updated_at,
      })),
    };
  });

export const retryDlqJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ account_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { count, error } = await supabaseAdmin
      .from("message_jobs")
      .update({
        status: "pending",
        attempt: 0,
        next_run_at: new Date().toISOString(),
        locked_at: null,
        last_error: null,
      }, { count: "exact" })
      .eq("user_id", context.userId)
      .eq("gmail_account_id", data.account_id)
      .eq("status", "dlq");
    if (error) throw new Error(error.message);
    return { requeued: count ?? 0 };
  });

export const retryDlqJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ job_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("message_jobs")
      .update({
        status: "pending",
        attempt: 0,
        next_run_at: new Date().toISOString(),
        locked_at: null,
        last_error: null,
      })
      .eq("id", data.job_id)
      .eq("user_id", context.userId)
      .eq("status", "dlq");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteDlqJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ job_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("message_jobs")
      .delete()
      .eq("id", data.job_id)
      .eq("user_id", context.userId)
      .eq("status", "dlq");
    if (error) throw new Error(error.message);
    return { ok: true };
  });
