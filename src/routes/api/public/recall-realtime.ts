// Recall.ai real-time endpoint. Receives transcript + chat events and reacts
// to "Hey Zerrow" / "@Zerrow" wake phrases by answering in the meeting chat.
//
// Configured via createBot() to POST here with `?t=<RECALL_REALTIME_TOKEN>`.
import { createFileRoute } from "@tanstack/react-router";
import {
  askZerrowInMeeting,
  appendTranscriptSegments,
  ensureTranscriptBuffer,
  type TranscriptSeg,
} from "@/lib/meetings/hey-zerrow.server";
import { constantTimeEqual } from "@/lib/constant-time.server";
import { logError, logInfo, newRunId } from "@/lib/log.server";

const WAKE_RE = /(?:^|[\s,.:;!?])(?:@zerrow|hey\s+zerrow)[\s,:;-]+(.+)/i;

type RealtimePayload = {
  event?: string;
  data?: {
    bot?: { id?: string };
    data?: {
      words?: Array<{ text?: string; start_timestamp?: { relative?: number } | number }>;
      participant?: { name?: string | null } | null;
      text?: string;
      sender?: { name?: string | null; is_host?: boolean } | null;
      is_from_bot?: boolean;
    };
  };
};

function extractQuestion(text: string): string | null {
  const m = text.match(WAKE_RE);
  if (!m) return null;
  const q = m[1].trim();
  // Require at least 3 words to reduce false triggers on stray "hey zerrow".
  if (q.split(/\s+/).length < 3) return null;
  return q.slice(0, 500);
}

export const Route = createFileRoute("/api/public/recall-realtime")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const runId = newRunId();
        const expected = process.env.RECALL_REALTIME_TOKEN?.trim();
        const url = new URL(request.url);
        // Prefer the token in a header (kept out of access/proxy logs); fall
        // back to the legacy `?t=` query param Recall was originally configured
        // with. Compare in constant time to avoid leaking the secret via timing.
        const token = (request.headers.get("x-recall-token") ?? url.searchParams.get("t"))?.trim();
        if (!expected || !token || !constantTimeEqual(token, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        let payload: RealtimePayload;
        try {
          payload = (await request.json()) as RealtimePayload;
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        const botId = payload.data?.bot?.id;
        const event = payload.event ?? "";
        if (!botId) return new Response("ok");

        const buffer = await ensureTranscriptBuffer(botId);
        if (!buffer) {
          logInfo("recall_realtime_no_meeting", { runId, botId });
          return new Response("ok");
        }

        try {
          if (event.startsWith("transcript.")) {
            const inner = payload.data?.data ?? {};
            const words = inner.words ?? [];
            const text = words
              .map((w) => w.text ?? "")
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
            if (!text) return new Response("ok");

            const seg: TranscriptSeg = {
              t: Date.now(),
              s: inner.participant?.name ?? null,
              w: text,
            };
            await appendTranscriptSegments(botId, [seg]);

            const question = extractQuestion(text);
            if (question) {
              await askZerrowInMeeting({
                botId,
                question,
                source: "voice",
                asker: seg.s,
              });
            }
          } else if (event.includes("chat_message")) {
            const inner = payload.data?.data ?? {};
            if (inner.is_from_bot) return new Response("ok");
            const text = (inner.text ?? "").trim();
            if (!text) return new Response("ok");

            const question = extractQuestion(text);
            if (question) {
              await askZerrowInMeeting({
                botId,
                question,
                source: "chat",
                asker: inner.sender?.name ?? null,
              });
            }
          }
        } catch (e) {
          logError("recall_realtime_handler_failed", {
            runId,
            botId,
            event,
            err: e instanceof Error ? e.message : String(e),
          });
        }

        return new Response("ok");
      },
    },
  },
});
