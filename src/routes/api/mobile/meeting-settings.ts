// Mobile API — the user's meeting-bot / notetaker settings.
// GET  /api/mobile/meeting-settings  -> { settings }
// POST /api/mobile/meeting-settings  { botName, chatMessage, chatResendOnJoin } -> { settings }
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { authenticateRequest } from "@/lib/mobile-auth.server";

const DEFAULT_BOT_NAME = "Zerrow Notetaker";
const DEFAULT_CHAT_MESSAGE =
  "Hi, I'm the Zerrow notetaker and I'll be taking notes for this meeting.";

const settingsSchema = z.object({
  botName: z.string().trim().min(1).max(100),
  chatMessage: z.string().max(1000),
  chatResendOnJoin: z.boolean(),
});

export const Route = createFileRoute("/api/mobile/meeting-settings")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { supabase, userId } = await authenticateRequest(request);
          const { data } = await supabase
            .from("meeting_bot_settings")
            .select("bot_name, chat_message, chat_resend_on_join, avatar_updated_at")
            .eq("user_id", userId)
            .maybeSingle();
          return Response.json({
            settings: {
              botName: data?.bot_name ?? DEFAULT_BOT_NAME,
              chatMessage: data?.chat_message ?? DEFAULT_CHAT_MESSAGE,
              chatResendOnJoin: data?.chat_resend_on_join ?? true,
              hasAvatar: !!data?.avatar_updated_at,
            },
          });
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }
      },
      POST: async ({ request }) => {
        let userId: string;
        let supabase: Awaited<ReturnType<typeof authenticateRequest>>["supabase"];
        try {
          ({ userId, supabase } = await authenticateRequest(request));
        } catch (r) {
          if (r instanceof Response) return r;
          return new Response("Unauthorized", { status: 401 });
        }

        let body: z.infer<typeof settingsSchema>;
        try {
          body = settingsSchema.parse(await request.json());
        } catch {
          return new Response("Invalid settings", { status: 400 });
        }

        const { error } = await supabase.from("meeting_bot_settings").upsert(
          {
            user_id: userId,
            bot_name: body.botName.trim(),
            chat_message: body.chatMessage.trim(),
            chat_resend_on_join: body.chatResendOnJoin,
          },
          { onConflict: "user_id" },
        );
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 400 });
        }
        return Response.json({ ok: true });
      },
    },
  },
});
