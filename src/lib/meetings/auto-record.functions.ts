import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { createBot, leaveBot, detectPlatform, type TranscriptSegment } from "../recall.server";
import { logError } from "../log.server";
import {
  extractMeetingUrl,
  NO_LINK_MESSAGE,
  EMAIL_RE,
  DOMAIN_RE,
  DEFAULT_CHAT_MESSAGE,
  SPECIAL_EVENT_TYPES,
  DEFAULT_HIDDEN_TYPES,
  EVENT_COLOR_IDS,
} from "../meetings-helpers.server";

export const setAutoRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ accountId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("gmail_accounts")
      .update({ auto_record_meetings: data.enabled })
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

/** Toggle "record meetings I've declined" for one connected account. */
export const setRecordDeclined = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ accountId: z.string().uuid(), enabled: z.boolean() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("gmail_accounts")
      .update({ record_declined_meetings: data.enabled })
      .eq("id", data.accountId);
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

/** Auto-record status for one account (used by the settings card). */
export const getAutoRecordStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ accountId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: acct, error } = await context.supabase
      .from("gmail_accounts")
      .select("auto_record_meetings, calendar_access, record_declined_meetings")
      .eq("id", data.accountId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      enabled: !!acct?.auto_record_meetings,
      calendarAccess: !!acct?.calendar_access,
      recordDeclined: !!acct?.record_declined_meetings,
    };
  });
