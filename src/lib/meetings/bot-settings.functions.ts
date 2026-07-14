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

/** Get the caller's meeting-bot customization (name, chat message, picture). */
export const getMeetingBotSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("meeting_bot_settings")
      .select(
        "bot_name, chat_message, chat_resend_on_join, avatar_updated_at, auto_leave_enabled, auto_leave_minutes",
      )
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      botName: data?.bot_name ?? "Zerrow Notetaker",
      chatMessage: data?.chat_message ?? DEFAULT_CHAT_MESSAGE,
      chatResendOnJoin: data?.chat_resend_on_join ?? true,
      hasAvatar: !!data?.avatar_updated_at,
      autoLeaveEnabled: data?.auto_leave_enabled ?? true,
      autoLeaveMinutes: data?.auto_leave_minutes ?? 30,
    };
  });

/**
 * Save the caller's meeting-bot customization. The picture itself is uploaded
 * straight to storage by the client (RLS-scoped to the user's own folder);
 * this only records the text/toggle settings and whether an avatar now exists.
 */
export const updateMeetingBotSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        botName: z.string().trim().min(1).max(100),
        chatMessage: z.string().max(1000),
        chatResendOnJoin: z.boolean(),
        autoLeaveEnabled: z.boolean(),
        autoLeaveMinutes: z.number().int().min(5).max(240),
        // "set" when a new picture was just uploaded, "clear" to remove it,
        // omitted to leave the existing picture untouched.
        avatar: z.enum(["set", "clear"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const patch: {
      user_id: string;
      bot_name: string;
      chat_message: string;
      chat_resend_on_join: boolean;
      auto_leave_enabled: boolean;
      auto_leave_minutes: number;
      avatar_updated_at?: string | null;
    } = {
      user_id: context.userId,
      bot_name: data.botName.trim(),
      chat_message: data.chatMessage.trim(),
      chat_resend_on_join: data.chatResendOnJoin,
      auto_leave_enabled: data.autoLeaveEnabled,
      auto_leave_minutes: data.autoLeaveMinutes,
    };
    if (data.avatar === "set") patch.avatar_updated_at = new Date().toISOString();
    if (data.avatar === "clear") {
      patch.avatar_updated_at = null;
      await context.supabase.storage
        .from("meeting-bot-avatars")
        .remove([`${context.userId}/avatar.jpg`]);
    }

    const { error } = await context.supabase
      .from("meeting_bot_settings")
      .upsert(patch, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
