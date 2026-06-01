import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const ADMIN_EMAILS = ["chris@nucar.com"];

function isAdminEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  return ADMIN_EMAILS.includes(email.toLowerCase().trim());
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
