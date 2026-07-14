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

/** Get the caller's event-type/color capture preferences for the meetings list. */
export const getMeetingEventPrefs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meeting_bot_settings")
      .select("hidden_event_types, event_color_skip")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      hiddenEventTypes: data?.hidden_event_types ?? DEFAULT_HIDDEN_TYPES,
      colorSkip: data?.event_color_skip ?? [],
    };
  });

/** Save the caller's event-type/color capture preferences. */
export const updateMeetingEventPrefs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        hiddenEventTypes: z.array(z.enum(SPECIAL_EVENT_TYPES)),
        colorSkip: z.array(z.enum(EVENT_COLOR_IDS)),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // Dedupe so the stored arrays stay tidy.
    const hidden = [...new Set(data.hiddenEventTypes)];
    const colors = [...new Set(data.colorSkip)];
    const { error } = await context.supabase
      .from("meeting_bot_settings")
      .upsert(
        { user_id: context.userId, hidden_event_types: hidden, event_color_skip: colors },
        { onConflict: "user_id" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
