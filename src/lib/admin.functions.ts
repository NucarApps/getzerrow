import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Admin emails are configured via the ADMIN_EMAILS env var (comma-separated),
// kept out of source so the privileged account is not disclosed in the codebase.
function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.toLowerCase().trim())
    .filter((e) => e.length > 0);
}

function isAdminEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  return adminEmails().includes(email.toLowerCase().trim());
}

function assertAdmin(claims: unknown): string {
  const email = (claims as { email?: unknown })?.email;
  if (!isAdminEmail(email)) {
    throw new Response("Forbidden", { status: 403 });
  }
  return String(email).toLowerCase();
}

export const getAdminMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const email = assertAdmin(context.claims);
    return { email };
  });

export type AdminGmailAccount = {
  email_address: string | null;
  last_poll_at: string | null;
  last_push_at: string | null;
  watch_expiration: string | null;
  has_history_id: boolean;
};

export type AdminUser = {
  user_id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  gmail_accounts: AdminGmailAccount[];
  stats: {
    emails: number;
    folders: number;
    contacts: number;
    jobs_pending: number;
    jobs_running: number;
    jobs_dlq: number;
  };
};

export const listAdminUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ users: AdminUser[] }> => {
    assertAdmin(context.claims);

    // Fetch all auth users (paginated).
    const authUsers: Array<{
      id: string;
      email: string | null;
      created_at: string;
      last_sign_in_at: string | null;
    }> = [];
    let page = 1;
    const perPage = 200;
    while (true) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
      if (error) throw new Error(error.message);
      const batch = data?.users ?? [];
      for (const u of batch) {
        authUsers.push({
          id: u.id,
          email: u.email ?? null,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
        });
      }
      if (batch.length < perPage) break;
      page += 1;
      if (page > 50) break; // safety
    }

    const [statsRes, gmailRes] = await Promise.all([
      supabaseAdmin.rpc("admin_user_stats"),
      supabaseAdmin
        .from("gmail_accounts")
        .select("user_id,email_address,last_poll_at,last_push_at,watch_expiration,history_id"),
    ]);

    if (statsRes.error) throw new Error(statsRes.error.message);
    if (gmailRes.error) throw new Error(gmailRes.error.message);

    const statsByUser = new Map<string, AdminUser["stats"]>();
    for (const r of (statsRes.data ?? []) as Array<{
      user_id: string;
      email_count: number | string;
      folder_count: number | string;
      contact_count: number | string;
      jobs_pending: number | string;
      jobs_running: number | string;
      jobs_dlq: number | string;
    }>) {
      statsByUser.set(r.user_id, {
        emails: Number(r.email_count),
        folders: Number(r.folder_count),
        contacts: Number(r.contact_count),
        jobs_pending: Number(r.jobs_pending),
        jobs_running: Number(r.jobs_running),
        jobs_dlq: Number(r.jobs_dlq),
      });
    }

    const gmailByUser = new Map<string, AdminGmailAccount[]>();
    for (const g of gmailRes.data ?? []) {
      const list = gmailByUser.get(g.user_id) ?? [];
      list.push({
        email_address: g.email_address ?? null,
        last_poll_at: g.last_poll_at ?? null,
        last_push_at: g.last_push_at ?? null,
        watch_expiration: g.watch_expiration ?? null,
        has_history_id: !!g.history_id,
      });
      gmailByUser.set(g.user_id, list);
    }
    for (const list of gmailByUser.values()) {
      list.sort((a, b) => (a.email_address ?? "").localeCompare(b.email_address ?? ""));
    }

    const users: AdminUser[] = authUsers.map((u) => ({
      user_id: u.id,
      email: u.email ?? "(no email)",
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      gmail_accounts: gmailByUser.get(u.id) ?? [],
      stats: statsByUser.get(u.id) ?? {
        emails: 0,
        folders: 0,
        contacts: 0,
        jobs_pending: 0,
        jobs_running: 0,
        jobs_dlq: 0,
      },
    }));

    users.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { users };
  });

export const getAdminActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { days?: number } | undefined) =>
    z.object({ days: z.number().int().min(7).max(180).optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    assertAdmin(context.claims);
    const days = data.days ?? 30;
    const { data: rows, error } = await supabaseAdmin.rpc("admin_daily_activity", { p_days: days });
    if (error) throw new Error(error.message);
    const series = (rows ?? []) as Array<{ day: string; signups: number; emails: number }>;
    return {
      days,
      signups: series.map((r) => ({ date: r.day, count: Number(r.signups) })),
      emails: series.map((r) => ({ date: r.day, count: Number(r.emails) })),
    };
  });

// ─── Folder-write retry-rate metrics (instability dashboard) ────────────────

export type RetryDailyPoint = { date: string; retries: number; failed: number };

export type RetryFolderRow = {
  folder_id: string | null;
  name: string;
  retries: number;
  failed: number;
  max_attempts: number;
  last_at: string;
};

export type RetryAlertRow = {
  folder_id: string | null;
  name: string;
  retry_count: number;
  fired_at: string;
};

export type FolderRetryMetrics = {
  days: number;
  totals: { retries: number; failed: number; folders_affected: number };
  daily: RetryDailyPoint[];
  byFolder: RetryFolderRow[];
  recentAlerts: RetryAlertRow[];
};

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Aggregate the durable folder_write_retries log into a dashboard view: a daily
 * retries/failed series, a per-folder breakdown, and recently-fired retry
 * alerts. Retries are rare, so fetching the (retention-bounded) window and
 * aggregating in memory is cheap and avoids a bespoke SQL function.
 */
export const getFolderRetryMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { days?: number } | undefined) =>
    z.object({ days: z.number().int().min(1).max(30).optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }): Promise<FolderRetryMetrics> => {
    assertAdmin(context.claims);
    const days = data.days ?? 7;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const [retryRes, alertRes] = await Promise.all([
      supabaseAdmin
        .from("folder_write_retries")
        .select("folder_id, occurred_at, attempts, outcome")
        .gte("occurred_at", since)
        .order("occurred_at", { ascending: false })
        .limit(10000),
      supabaseAdmin
        .from("folder_retry_alerts")
        .select("folder_id, retry_count, fired_at")
        .gte("fired_at", since)
        .order("fired_at", { ascending: false })
        .limit(200),
    ]);
    if (retryRes.error) throw new Error(retryRes.error.message);
    if (alertRes.error) throw new Error(alertRes.error.message);

    const retries = (retryRes.data ?? []) as Array<{
      folder_id: string | null;
      occurred_at: string;
      attempts: number;
      outcome: string;
    }>;
    const alerts = (alertRes.data ?? []) as Array<{
      folder_id: string | null;
      retry_count: number;
      fired_at: string;
    }>;

    // Resolve folder names for display.
    const folderIds = new Set<string>();
    for (const r of retries) if (r.folder_id) folderIds.add(r.folder_id);
    for (const a of alerts) if (a.folder_id) folderIds.add(a.folder_id);
    const nameById = new Map<string, string>();
    if (folderIds.size > 0) {
      const { data: folders, error: folderErr } = await supabaseAdmin
        .from("folders")
        .select("id, name")
        .in("id", Array.from(folderIds));
      if (folderErr) throw new Error(folderErr.message);
      for (const f of folders ?? []) nameById.set(f.id, f.name);
    }
    const displayName = (id: string | null): string =>
      id ? (nameById.get(id) ?? "(deleted folder)") : "(no folder)";

    // Daily series (fill every day so the chart has no gaps).
    const dailyMap = new Map<string, RetryDailyPoint>();
    for (let i = days - 1; i >= 0; i--) {
      const key = dayKey(new Date(Date.now() - i * 86_400_000).toISOString());
      dailyMap.set(key, { date: key, retries: 0, failed: 0 });
    }
    // Per-folder aggregation.
    const folderMap = new Map<string, RetryFolderRow>();
    let totalRetries = 0;
    let totalFailed = 0;

    for (const r of retries) {
      const isFailed = r.outcome === "failure";
      totalRetries += 1;
      if (isFailed) totalFailed += 1;

      const dKey = dayKey(r.occurred_at);
      const point = dailyMap.get(dKey);
      if (point) {
        point.retries += 1;
        if (isFailed) point.failed += 1;
      }

      const fKey = r.folder_id ?? "null";
      const attempts = Number.isFinite(r.attempts) ? r.attempts : 0;
      const existing = folderMap.get(fKey);
      if (existing) {
        existing.retries += 1;
        if (isFailed) existing.failed += 1;
        if (attempts > existing.max_attempts) existing.max_attempts = attempts;
        if (r.occurred_at > existing.last_at) existing.last_at = r.occurred_at;
      } else {
        folderMap.set(fKey, {
          folder_id: r.folder_id ?? null,
          name: displayName(r.folder_id ?? null),
          retries: 1,
          failed: isFailed ? 1 : 0,
          max_attempts: attempts,
          last_at: r.occurred_at,
        });
      }
    }

    const byFolder = Array.from(folderMap.values()).sort((a, b) => b.retries - a.retries);
    const recentAlerts: RetryAlertRow[] = alerts.map((a) => ({
      folder_id: a.folder_id ?? null,
      name: displayName(a.folder_id ?? null),
      retry_count: Number(a.retry_count),
      fired_at: a.fired_at,
    }));

    return {
      days,
      totals: { retries: totalRetries, failed: totalFailed, folders_affected: byFolder.length },
      daily: Array.from(dailyMap.values()),
      byFolder,
      recentAlerts,
    };
  });
