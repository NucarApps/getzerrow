// Recall.ai real-time endpoint. Receives transcript + chat events and reacts
// to "Hey Atzro" / "@Atzro" wake phrases by answering in the meeting chat.
//
// Configured via createBot() to POST here with `?t=<RECALL_REALTIME_TOKEN>`.
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  askAtzroInMeeting,
  appendTranscriptSegments,
  ensureTranscriptBuffer,
  type TranscriptSeg,
} from "@/lib/meetings/hey-atzro.server";
import { constantTimeEqual } from "@/lib/constant-time.server";
import { logError, logInfo, newRunId } from "@/lib/log.server";

// "zerrow" stays a silent alias for the pre-rebrand wake phrase so meetings
// already in flight (and habit) keep working after the rename to Atzro.
const WAKE_RE = /(?:^|[\s,.:;!?])(?:@atzro|@zerrow|hey\s+atzro|hey\s+zerrow)[\s,:;-]+(.+)/i;

// Untrusted real-time event from Recall — validate the shape rather than cast.
// Unknown keys are stripped so Recall can extend the payload without breaking us.
// Tolerant by design: this is a high-volume transcript firehose, so the schema
// only pins the fields the handler actually reads and stays nullish elsewhere —
// one oddly-shaped word must never 400 away a whole batch (and its wake word).
// Unknown keys (e.g. word `start_timestamp`, which we don't read) are stripped.
const recallRealtimeSchema = z.object({
  event: z.string().nullish(),
  data: z
    .object({
      bot: z.object({ id: z.string().nullish() }).nullish(),
      data: z
        .object({
          words: z.array(z.object({ text: z.string().nullish() })).nullish(),
          participant: z.object({ name: z.string().nullish() }).nullish(),
          text: z.string().nullish(),
          sender: z
            .object({ name: z.string().nullish(), is_host: z.boolean().nullish() })
            .nullish(),
          is_from_bot: z.boolean().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
type RealtimePayload = z.infer<typeof recallRealtimeSchema>;

function extractQuestion(text: string): string | null {
  const m = text.match(WAKE_RE);
  const q = m?.[1]?.trim();
  if (!q) return null;
  // Require at least 3 words to reduce false triggers on stray "hey atzro".
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
          const parsed = recallRealtimeSchema.safeParse(await request.json());
          if (!parsed.success) return new Response("Bad request", { status: 400 });
          payload = parsed.data;
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
              await askAtzroInMeeting({
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
              await askAtzroInMeeting({
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
