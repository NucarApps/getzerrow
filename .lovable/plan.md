# "Hey Zerrow" in-meeting Q&A (chat reply, current meeting only)

Interactive assistant that listens for a wake phrase during a Recall.ai-recorded meeting and posts an AI answer in the meeting chat, using only the live transcript of the current call.

## How it works

```text
Recall bot (already in call)
   │  real-time transcript + chat events (webhook)
   ▼
/api/public/recall-realtime  ── verifies shared secret
   │
   ├─ appends transcript to per-bot rolling buffer
   ├─ detects wake trigger:
   │     • voice: "hey zerrow …"        (transcript.data)
   │     • chat: "@zerrow …" / "hey zerrow …"  (chat.message events)
   │
   ▼
askZerrowInMeeting(botId, question)
   │  Lovable AI Gateway (google/gemini-3.5-flash)
   │  system prompt + last ~15 min of transcript as context
   ▼
Recall "Send Chat Message" API → answer appears in meeting chat
   │
   ▼
meeting_qa row (audit + optional UI later)
```

## Changes

### 1. Recall bot config (`src/lib/recall.server.ts`)
- On `createRecallBot`, subscribe to real-time events by adding:
  - `realtime_endpoints: [{ type: "webhook", url: <public webhook>, events: ["transcript.data", "chat_messages.data", "participant_events.chat_message_sent"] }]`
  - `chat: { host_only: false }` if not already enabled, so the bot can send chat.
- Add `sendBotChatMessage(botId, text)` calling `POST /api/v1/bot/{id}/send_chat_message/` with `{ to: "everyone", message }`.
- URL includes a per-project shared secret query token (`?t=<RECALL_REALTIME_TOKEN>`) since Recall webhooks don't sign real-time endpoints.

### 2. New webhook route: `src/routes/api/public/recall-realtime.ts`
- Verify `?t=` matches `RECALL_REALTIME_TOKEN` (generated secret).
- Handle event shapes:
  - `transcript.data` → append `{words, speaker, ts}` to `bot_transcript_buffer` (in-DB rolling window, trimmed to last 30 min or 8k tokens).
  - `chat_messages.data` → inspect message text.
- Wake-phrase matcher: regex `/(?:^|\s)(?:@zerrow|hey\s+zerrow)[,:\s]+(.+)/i`; ignore messages authored by the bot itself; debounce 3s per bot to avoid duplicate triggers when both voice + chat fire.
- Enqueue answer job (inline for MVP — the LLM call takes 1-3s, well under the 25s Worker limit).

### 3. Answering logic: `src/lib/meetings/hey-zerrow.server.ts`
- `askZerrowInMeeting({ botId, question })`:
  - Load bot row → owning `user_id` + `meeting_id`.
  - Read last ~15 min of the rolling transcript buffer for that bot.
  - Call Lovable AI (`google/gemini-3.5-flash`) via `createLovableAiGatewayProvider` + `generateText`. Prompt: "You are Zerrow, an assistant listening to this meeting. Answer briefly (≤ 60 words) using ONLY the transcript. If the transcript doesn't contain the answer, say so."
  - Post via `sendBotChatMessage(botId, "Zerrow: " + answer)`.
  - Insert into `meeting_qa` (bot_id, meeting_id, user_id, trigger_source: 'voice'|'chat', question, answer, latency_ms).
  - Graceful failure: post `"Zerrow: I couldn't answer that — try again."` on error.

### 4. Database migration
```sql
CREATE TABLE public.meeting_transcript_buffer (
  bot_id text PRIMARY KEY,
  meeting_id uuid REFERENCES public.meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  segments jsonb NOT NULL DEFAULT '[]'::jsonb,   -- rolling window
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.meeting_qa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id text NOT NULL,
  meeting_id uuid REFERENCES public.meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  trigger_source text NOT NULL CHECK (trigger_source IN ('voice','chat')),
  question text NOT NULL,
  answer text,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.meeting_qa TO authenticated;
GRANT ALL ON public.meeting_qa, public.meeting_transcript_buffer TO service_role;
ALTER TABLE public.meeting_qa ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meeting_transcript_buffer ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own qa" ON public.meeting_qa FOR SELECT TO authenticated USING (user_id = auth.uid());
-- transcript buffer is service_role only (webhook-managed); no authenticated policy needed
```

### 5. Secrets
- `RECALL_REALTIME_TOKEN` — generated via `generate_secret` (32 chars). Used to authenticate real-time webhook.
- `LOVABLE_API_KEY` — already set.
- Webhook URL uses stable `project--{id}.lovable.app/api/public/recall-realtime?t=<token>`.

### 6. Not in this pass
- Voice reply into the call (would need Recall Output Audio + TTS).
- Cross-meeting RAG (emails/contacts).
- UI to browse Q&A history — data captured now, surface later.

## Risks / notes
- Recall real-time webhooks fire frequently; the buffer table gets one UPDATE per transcript chunk (~1/sec per active speaker). Trim inline to cap row size.
- Wake-phrase false positives on voice ("Hey, zero…") — mitigated by requiring a follow-up question of ≥3 words and a 3s debounce.
- Bot must have chat send permission on the platform (Zoom host-only chat can block it — surface a hint in the meeting UI if `send_chat_message` returns 4xx).
