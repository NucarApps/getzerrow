// Server-only helper for sending Expo push notifications to a user's mobile
// devices. Tokens live in device_push_tokens (RLS-scoped per user); the mobile
// app registers them on login. Every function here is best-effort and must
// never throw into a caller — push is a side effect, not a critical path.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { logError } from "./log.server";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

type PushPayload = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

/** Send a push to every registered device for a user. Best-effort. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<void> {
  try {
    const { data: tokens } = await supabaseAdmin
      .from("device_push_tokens")
      .select("expo_token")
      .eq("user_id", userId);

    const messages = (tokens ?? [])
      .map((t) => t.expo_token)
      .filter((to): to is string => typeof to === "string" && to.startsWith("ExponentPushToken"))
      .map((to) => ({
        to,
        sound: "default" as const,
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
      }));

    if (messages.length === 0) return;

    await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    logError("push.send_failed", { user_id: userId }, e);
  }
}

/** Notify a user that new mail landed in their inbox needing attention. */
export async function notifyInboxMail(
  userId: string,
  mail: { from_name?: string | null; from_addr?: string | null; subject?: string | null },
): Promise<void> {
  const sender = mail.from_name?.trim() || mail.from_addr?.trim() || "New email";
  const subject = mail.subject?.trim() || "(no subject)";
  await sendPushToUser(userId, {
    title: sender,
    body: subject,
    data: { type: "inbox_mail" },
  });
}
