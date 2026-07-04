// Recall.ai REST client — server-only. Sends meeting bots that join
// Zoom/Meet/Teams calls to record and transcribe, then exposes the recording
// URL, transcript, and summary. Reads RECALL_API_KEY / RECALL_REGION inside
// each call so env injection works on the Worker runtime.
//
// Docs: https://docs.recall.ai/reference

const DEFAULT_REGION = "us-west-2";
const REQUEST_TIMEOUT_MS = 20_000;

function recallBase(): string {
  const region = process.env.RECALL_REGION?.trim() || DEFAULT_REGION;
  return `https://${region}.recall.ai/api/v1`;
}

function requireApiKey(): string {
  const key = process.env.RECALL_API_KEY;
  if (!key) throw new Error("RECALL_API_KEY is not configured");
  return key;
}

export class RecallApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RecallApiError";
    this.status = status;
  }
}

async function recallFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${recallBase()}${path}`, {
    method: init.method ?? "GET",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Token ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RecallApiError(`Recall API ${res.status} on ${path}: ${text.slice(0, 300)}`, res.status);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** Coarse platform label derived from a meeting URL. */
export function detectPlatform(url: string): string | null {
  const u = url.toLowerCase();
  if (u.includes("zoom.us")) return "zoom";
  if (u.includes("meet.google.com")) return "google_meet";
  if (u.includes("teams.microsoft.com") || u.includes("teams.live.com")) return "microsoft_teams";
  if (u.includes("webex.com")) return "webex";
  return null;
}

/** Basic shape of a Recall bot resource (only the fields we use). */
export type RecallBot = {
  id: string;
  status_changes?: Array<{ code: string; created_at: string; message?: string | null }>;
  meeting_url?: { meeting_id?: string; platform?: string } | string | null;
  recordings?: Array<{
    id: string;
    media_shortcuts?: {
      video_mixed?: { data?: { download_url?: string } };
      transcript?: {
        data?: { download_url?: string };
      };
    };
  }>;
  video_url?: string | null;
};

type CreateBotInput = {
  meetingUrl: string;
  botName?: string;
  /** ISO timestamp; when set, Recall schedules the bot to join at that time. */
  joinAt?: string | null;
};

/**
 * Create a meeting bot. Requests Recall's built-in meeting-caption transcript
 * (no third-party transcription provider needed) plus a mixed video recording.
 */
export async function createBot(input: CreateBotInput): Promise<RecallBot> {
  const body: Record<string, unknown> = {
    meeting_url: input.meetingUrl,
    bot_name: input.botName?.slice(0, 100) || "Zerrow Notetaker",
    recording_config: {
      transcript: { provider: { meeting_captions: {} } },
    },
  };
  if (input.joinAt) body.join_at = input.joinAt;
  return recallFetch<RecallBot>("/bot", { method: "POST", body });
}

/** Fetch the current bot resource. */
export async function getBot(botId: string): Promise<RecallBot> {
  return recallFetch<RecallBot>(`/bot/${botId}`);
}

/** Remove a bot from a call (best-effort; ignores "already gone" errors). */
export async function leaveBot(botId: string): Promise<void> {
  try {
    await recallFetch(`/bot/${botId}/leave_call`, { method: "POST" });
  } catch (e) {
    if (e instanceof RecallApiError && (e.status === 400 || e.status === 404)) return;
    throw e;
  }
}

/** A single speaker-labelled transcript segment we render in the UI. */
export type TranscriptSegment = { speaker: string | null; text: string; start: number | null };

type RecallTranscriptWord = { text?: string; start_timestamp?: { relative?: number } | number };
type RecallTranscriptEntry = {
  speaker?: string | null;
  words?: RecallTranscriptWord[];
};

function wordStart(w: RecallTranscriptWord): number | null {
  const ts = w.start_timestamp;
  if (typeof ts === "number") return ts;
  if (ts && typeof ts === "object" && typeof ts.relative === "number") return ts.relative;
  return null;
}

/** Fetch and normalize the transcript into speaker segments. Empty when none. */
export async function getTranscript(botId: string): Promise<TranscriptSegment[]> {
  let entries: RecallTranscriptEntry[];
  try {
    entries = await recallFetch<RecallTranscriptEntry[]>(`/bot/${botId}/transcript`);
  } catch (e) {
    if (e instanceof RecallApiError && e.status === 404) return [];
    throw e;
  }
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const words = entry.words ?? [];
      const text = words
        .map((w) => w.text ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const start = words.length ? wordStart(words[0]) : null;
      return { speaker: entry.speaker ?? null, text, start };
    })
    .filter((s) => s.text.length > 0);
}

/** Extract the mixed-video recording download URL from a bot, if ready. */
export function extractRecordingUrl(bot: RecallBot): string | null {
  const rec = bot.recordings?.[0];
  const shortcut = rec?.media_shortcuts?.video_mixed?.data?.download_url;
  return shortcut ?? bot.video_url ?? null;
}

/** Latest status code Recall reported for the bot (e.g. "done", "call_ended"). */
export function latestStatusCode(bot: RecallBot): string | null {
  const changes = bot.status_changes ?? [];
  return changes.length ? changes[changes.length - 1].code : null;
}

/**
 * Build a plain-text summary from Recall's transcript output. Keeps the feature
 * "Recall only" (no external LLM): a compact extractive digest of the longest,
 * most substantive segments in speaker order.
 */
export function summarizeTranscript(segments: TranscriptSegment[]): string | null {
  if (!segments.length) return null;
  const substantive = segments
    .filter((s) => s.text.split(/\s+/).length >= 6)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 8)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const chosen = substantive.length ? substantive : segments.slice(0, 5);
  const lines = chosen.map((s) => {
    const who = s.speaker ? `${s.speaker}: ` : "";
    const text = s.text.length > 220 ? `${s.text.slice(0, 217)}…` : s.text;
    return `• ${who}${text}`;
  });
  return `Key moments\n${lines.join("\n")}`;
}
