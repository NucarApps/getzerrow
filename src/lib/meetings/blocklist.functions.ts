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

/** People/domains the caller never wants auto-recorded. */
export const listRecordBlocklist = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meeting_record_blocklist")
      .select("id, value, created_at")
      .eq("user_id", context.userId)
      .order("value", { ascending: true });
    if (error) throw new Error(error.message);
    return { entries: data ?? [] };
  });

/** Add an email or domain to the caller's don't-auto-record list. */
export const addRecordBlocklistEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        value: z
          .string()
          .trim()
          .min(1)
          .max(320)
          .transform((v) => v.toLowerCase())
          .refine((v) => EMAIL_RE.test(v) || DOMAIN_RE.test(v), {
            message: "Enter a valid email address or domain.",
          }),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("meeting_record_blocklist")
      .upsert({ user_id: context.userId, value: data.value }, { onConflict: "user_id,value" });
    if (error) throw new Error(error.message);
    return { ok: true, value: data.value };
  });

/** Remove an entry from the caller's don't-auto-record list. */
export const removeRecordBlocklistEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("meeting_record_blocklist")
      .delete()
      .eq("user_id", context.userId)
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
