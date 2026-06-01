import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  syncCalendarContacts,
  listCalendarPeople,
  CalendarApiError,
  type CalendarErrorKind,
  type CalendarPerson,
} from "./calendar.server";
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
      .select("calendar_guard_enabled, calendar_access, calendar_synced_at, calendar_sync_error")
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
      lastError: account?.calendar_sync_error ?? null,
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
    let syncReason: CalendarErrorKind | null = null;
    if (data.enabled && calendarAccess) {
      try {
        const r = await syncCalendarContacts(data.accountId, context.userId);
        synced = { contacts: r.contacts };
        invalidateAccountContext(data.accountId);
      } catch (e) {
        syncReason = e instanceof CalendarApiError ? e.kind : "unknown";
        logError("calendar.initial_sync_failed", { account_id: data.accountId, user_id: context.userId }, e);
      }
    }
    return { enabled: data.enabled, calendarAccess, synced, syncReason };
  });

/** On-demand resync of calendar attendees for an account. */
export const syncCalendarNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { calendarAccess } = await assertOwnsAccount(data.accountId, context.userId);
    if (!calendarAccess) {
      return { ok: false as const, reason: "reconnect" as CalendarErrorKind };
    }
    try {
      const r = await syncCalendarContacts(data.accountId, context.userId);
      invalidateAccountContext(data.accountId);
      return { ok: true as const, contacts: r.contacts, truncated: r.truncated };
    } catch (e) {
      if (e instanceof CalendarApiError) {
        return { ok: false as const, reason: e.kind };
      }
      logError("calendar.sync_now_failed", { account_id: data.accountId, user_id: context.userId }, e);
      return { ok: false as const, reason: "unknown" as CalendarErrorKind };
    }
  });

/** A meeting attendee surfaced for the "add from meetings" picker. */
export type MeetingPerson = {
  email: string;
  name: string | null;
  meetingAt: string | null;
  eventTitle: string | null;
};

/**
 * List people from the user's past or upcoming Google Calendar meetings who
 * are NOT already in their contacts (and aren't the user). Aggregates across
 * all calendar-enabled accounts, deduped by email. Per-account Google errors
 * are skipped so one bad account doesn't break the list.
 */
export const listMeetingPeople = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        when: z.enum(["past", "upcoming"]).default("past"),
        search: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;

    // Accounts that have granted calendar access.
    const { data: accounts } = await supabaseAdmin
      .from("gmail_accounts")
      .select("id")
      .eq("user_id", userId)
      .eq("calendar_access", true);

    if (!accounts || accounts.length === 0) {
      return { people: [] as MeetingPerson[], calendarAccess: false };
    }

    // Existing contact emails to exclude.
    const { data: existing } = await supabaseAdmin
      .from("contacts")
      .select("email")
      .eq("user_id", userId);
    const existingSet = new Set(
      (existing ?? []).map((c) => (c.email || "").toLowerCase()),
    );

    const merged = new Map<string, CalendarPerson>();
    for (const acc of accounts) {
      try {
        const people = await listCalendarPeople(acc.id, { when: data.when });
        for (const p of people) {
          if (existingSet.has(p.email)) continue;
          const cur = merged.get(p.email);
          if (!cur) {
            merged.set(p.email, { ...p });
            continue;
          }
          if (p.name && !cur.name) cur.name = p.name;
          const better =
            data.when === "upcoming"
              ? (p.meetingAt ?? "") < (cur.meetingAt ?? "\uffff")
              : (p.meetingAt ?? "") > (cur.meetingAt ?? "");
          if (better && p.meetingAt) {
            cur.meetingAt = p.meetingAt;
            cur.eventTitle = p.eventTitle;
          }
        }
      } catch (e) {
        logError(
          "calendar.list_people_failed",
          { account_id: acc.id, user_id: userId, when: data.when },
          e,
        );
      }
    }

    let list = [...merged.values()];

    const search = (data.search || "").toLowerCase().trim();
    if (search) {
      list = list.filter(
        (x) => x.email.includes(search) || (x.name ?? "").toLowerCase().includes(search),
      );
    }

    list.sort((a, b) => {
      const av = a.meetingAt ?? "";
      const bv = b.meetingAt ?? "";
      // Upcoming: soonest first. Past: most recent first.
      return data.when === "upcoming" ? av.localeCompare(bv) : bv.localeCompare(av);
    });

    const limit = data.limit ?? 200;
    return {
      people: list.slice(0, limit) as MeetingPerson[],
      calendarAccess: true,
    };
  });

