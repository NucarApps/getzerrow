import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncCalendarContacts, CalendarApiError } from "./calendar.server";
import { invalidateAccountContext } from "./sync/account-context";
import { logError } from "./log.server";

/** Confirm the calling user owns the given Gmail account. */
async function assertOwnsAccount(accountId: string, userId: string): Promise<{ calendarAccess: boolean }> {
  const { data } = await supabaseAdmin
    .from("gmail_accounts")
    .select("user_id, calendar_access")
    .eq("id", accountId)
    .maybeSingle();
  if (!data || data.user_id !== userId) throw new Error("Not authorized for this account");
  return { calendarAccess: !!data.calendar_access };
}

/** Current guard state + sync metadata for one account, used by the UI. */
export const getCalendarGuardStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    await assertOwnsAccount(data.accountId, context.userId);
    const { data: account } = await supabaseAdmin
      .from("gmail_accounts")
      .select("calendar_guard_enabled, calendar_access, calendar_synced_at")
      .eq("id", data.accountId)
      .maybeSingle();
    const { count } = await supabaseAdmin
      .from("calendar_contacts")
      .select("id", { count: "exact", head: true })
      .eq("gmail_account_id", data.accountId);
    return {
      enabled: !!account?.calendar_guard_enabled,
      calendarAccess: !!account?.calendar_access,
      syncedAt: account?.calendar_synced_at ?? null,
      contactCount: count ?? 0,
    };
  });

/** Turn the calendar cold-email guard on/off for an account. Turning it on
 * triggers an initial calendar sync when access has been granted. */
export const setCalendarGuard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ accountId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { calendarAccess } = await assertOwnsAccount(data.accountId, context.userId);

    const { error } = await supabaseAdmin
      .from("gmail_accounts")
      .update({ calendar_guard_enabled: data.enabled })
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);

    invalidateAccountContext(data.accountId);

    let synced: { contacts: number } | null = null;
    if (data.enabled && calendarAccess) {
      try {
        const r = await syncCalendarContacts(data.accountId, context.userId);
        synced = { contacts: r.contacts };
        invalidateAccountContext(data.accountId);
      } catch (e) {
        logError("calendar.initial_sync_failed", { account_id: data.accountId, user_id: context.userId }, e);
      }
    }
    return { enabled: data.enabled, calendarAccess, synced };
  });

/** On-demand resync of calendar attendees for an account. */
export const syncCalendarNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { calendarAccess } = await assertOwnsAccount(data.accountId, context.userId);
    if (!calendarAccess) {
      return { ok: false as const, reason: "no_calendar_access" as const };
    }
    try {
      const r = await syncCalendarContacts(data.accountId, context.userId);
      invalidateAccountContext(data.accountId);
      return { ok: true as const, contacts: r.contacts, truncated: r.truncated };
    } catch (e) {
      if (e instanceof CalendarApiError && (e.status === 401 || e.status === 403)) {
        return { ok: false as const, reason: "no_calendar_access" as const };
      }
      logError("calendar.sync_now_failed", { account_id: data.accountId, user_id: context.userId }, e);
      throw new Error("Couldn't sync your calendar. Please try again.");
    }
  });
