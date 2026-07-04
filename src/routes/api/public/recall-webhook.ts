// Recall.ai webhook — receives bot status changes and completion events.
// Verifies the Svix signature with RECALL_WEBHOOK_SECRET, then reconciles the
// matching meeting row (status, recording, transcript, summary, contact links).
//
// Configure Recall to POST here:
//   https://getzerrow.com/api/public/recall-webhook
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncMeetingFromRecall, mapStatus } from "@/lib/meetings.server";
import { logError, logInfo, newRunId } from "@/lib/log.server";

/** Verify a Svix-signed webhook. Secret format: `whsec_<base64>`. */
function verifySvix(secret: string, headers: Headers, body: string): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature) return false;

  const raw = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return false;
  }
  const signed = `${id}.${timestamp}.${body}`;
  const expected = createHmac("sha256", key).update(signed).digest("base64");
  const expectedBuf = Buffer.from(expected);
  // Header can carry several space-delimited `v1,<sig>` pairs.
  for (const part of signature.split(" ")) {
    const sig = part.includes(",") ? part.split(",")[1] : part;
    const sigBuf = Buffer.from(sig);
    if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) return true;
  }
  return false;
}

type RecallWebhookPayload = {
  event?: string;
  data?: {
    bot_id?: string;
    bot?: { id?: string };
    status?: { code?: string };
  };
};

export const Route = createFileRoute("/api/public/recall-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runId = newRunId();
        const secret = process.env.RECALL_WEBHOOK_SECRET;
        const body = await request.text();

        if (!secret || !verifySvix(secret, request.headers, body)) {
          logError("recall_webhook_unauthorized", { runId });
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: RecallWebhookPayload;
        try {
          payload = JSON.parse(body) as RecallWebhookPayload;
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const botId = payload.data?.bot?.id ?? payload.data?.bot_id ?? null;
        if (!botId) return new Response("ok");

        const { data: meeting } = await supabaseAdmin
          .from("meetings")
          .select("id, user_id, recall_bot_id, status")
          .eq("recall_bot_id", botId)
          .maybeSingle();
        if (!meeting) {
          logInfo("recall_webhook_no_meeting", { runId, botId });
          return new Response("ok");
        }

        const code = payload.data?.status?.code ?? null;
        const nextStatus = mapStatus(code);

        // For terminal/recording transitions, pull the full state (recording,
        // transcript, summary, participant→contact links). Otherwise just move
        // the status forward.
        if (nextStatus === "done" || nextStatus === "recording" || nextStatus === "failed") {
          await syncMeetingFromRecall(meeting);
        } else {
          await supabaseAdmin.from("meetings").update({ status: nextStatus }).eq("id", meeting.id);
        }

        logInfo("recall_webhook_handled", { runId, botId, code, nextStatus });
        return new Response("ok");
      },
    },
  },
});
