import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { collapseRunawayRepeats, maxConsecutiveBlockRepeats } from "./transcript-sanitize";

// The exact hallucination pattern from the reported iOS bug: a short block of
// sentences the speech-to-text model emitted over and over when handed audio it
// couldn't cleanly decode.
const RUNAWAY_BLOCK = "Why are we doing this later? Okay, hold on. ";
const HALLUCINATED_TRANSCRIPT = RUNAWAY_BLOCK.repeat(24).trim();

// Shared mutable state the hoisted module mocks read from / write to.
const state = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  transcriptResponse: "",
  sampleBytes: new Uint8Array(),
}));

// Mock the service-role client so no real network / env is needed. The storage
// download returns the uploaded problematic iOS recording sample; the meeting
// row points the finalizer at it.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: {
              id: "meeting-1",
              user_id: "user-1",
              audio_storage_path: "user-1/meeting-1.m4a",
            },
            error: null,
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          state.updates.push(payload);
          return { error: null };
        },
      }),
    }),
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([state.sampleBytes], { type: "audio/mp4" }),
          error: null,
        }),
      }),
    },
  },
}));

// Keep summary generation deterministic and offline.
vi.mock("ai", () => ({
  generateText: async () => ({ text: "Key moments\n• Discussed timing." }),
}));

describe("collapseRunawayRepeats", () => {
  it("collapses an alternating two-sentence loop (the iOS bug pattern)", () => {
    expect(maxConsecutiveBlockRepeats(HALLUCINATED_TRANSCRIPT)).toBeGreaterThanOrEqual(20);
    const cleaned = collapseRunawayRepeats(HALLUCINATED_TRANSCRIPT);
    expect(maxConsecutiveBlockRepeats(cleaned)).toBeLessThanOrEqual(2);
    expect(cleaned.length).toBeLessThan(HALLUCINATED_TRANSCRIPT.length / 5);
  });

  it("collapses a single sentence repeated many times", () => {
    const looped = "Thank you. ".repeat(30).trim();
    const cleaned = collapseRunawayRepeats(looped);
    expect(cleaned).toBe("Thank you.");
  });

  it("leaves a normal transcript untouched", () => {
    const normal =
      "Let's start the meeting. First we reviewed the roadmap. Then we agreed on next steps. " +
      "Sarah will send the notes. Thanks everyone.";
    expect(collapseRunawayRepeats(normal)).toBe(normal.trim());
  });

  it("keeps a genuine double emphasis (below the loop threshold)", () => {
    const emphasis = "No. No. That is not what we agreed on.";
    expect(collapseRunawayRepeats(emphasis)).toBe(emphasis);
  });
});

describe("finalizeInPersonMeeting regression — iOS-style problematic recording", () => {
  beforeEach(() => {
    process.env.LOVABLE_API_KEY = "test-key";
    state.updates = [];
    state.transcriptResponse = HALLUCINATED_TRANSCRIPT;
    state.sampleBytes = new Uint8Array(
      readFileSync(
        fileURLToPath(new URL("./__fixtures__/ios-recording-sample.m4a", import.meta.url)),
      ),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/audio/transcriptions")) {
          // Simulate the STT model hallucinating a runaway loop on the bad clip.
          return new Response(JSON.stringify({ text: state.transcriptResponse }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );
  });

  it("uploads the problematic sample and saves a transcript free of runaway phrases", async () => {
    // Sanity-check the fixture actually loaded (the "uploaded" recording).
    expect(state.sampleBytes.byteLength).toBeGreaterThan(1000);

    const { finalizeInPersonMeeting } = await import("./meetings.server");
    const status = await finalizeInPersonMeeting("meeting-1");
    expect(status).toBe("done");

    const saved = state.updates.find((u) => u.status === "done");
    expect(saved, "meeting should be saved as done").toBeTruthy();

    const segments = saved!.transcript as Array<{ text: string }>;
    const savedText = segments.map((s) => s.text).join(" ");

    // The raw model output was a 24x runaway loop; the persisted transcript must
    // not carry that repetition through to the UI.
    expect(maxConsecutiveBlockRepeats(HALLUCINATED_TRANSCRIPT)).toBeGreaterThanOrEqual(20);
    expect(maxConsecutiveBlockRepeats(savedText)).toBeLessThanOrEqual(2);
    expect(savedText.length).toBeLessThan(HALLUCINATED_TRANSCRIPT.length / 5);
  });

  it("still saves a clean transcript unchanged", async () => {
    state.transcriptResponse =
      "We kicked off the call. The team demoed the new flow. We shipped it to staging.";

    const { finalizeInPersonMeeting } = await import("./meetings.server");
    const status = await finalizeInPersonMeeting("meeting-1");
    expect(status).toBe("done");

    const saved = state.updates.find((u) => u.status === "done");
    const segments = saved!.transcript as Array<{ text: string }>;
    expect(segments[0].text).toBe(state.transcriptResponse);
  });
});

// iOS Safari emits fragmented MP4 (ftyp/moov/moof.../mdat), and the number of
// moof/mdat fragments varies with clip length and the browser's flush cadence.
// Short or heavily fragmented clips are exactly what triggered the STT to
// hallucinate runaway loops. These fixtures span 1, 2, 3, and 12 fragments so
// the regression proves the sanitizer holds regardless of fragmentation length.
const FRAGMENTATION_FIXTURES: Array<{ name: string; file: string; fragments: number }> = [
  { name: "single fragment", file: "ios-recording-sample.m4a", fragments: 1 },
  { name: "two fragments (short clip)", file: "ios-recording-short.m4a", fragments: 2 },
  {
    name: "three fragments (long frag duration)",
    file: "ios-recording-long-fragments.m4a",
    fragments: 3,
  },
  { name: "many small fragments", file: "ios-recording-many-fragments.m4a", fragments: 12 },
];

// A few distinct runaway shapes the STT model produces on undecodable audio:
// a single stuck sentence, an alternating two-sentence loop, and a longer
// three-sentence block. Each must be collapsed no matter the fixture.
const RUNAWAY_PATTERNS: Array<{ name: string; text: string }> = [
  { name: "single-sentence loop", text: "Thank you. ".repeat(40).trim() },
  {
    name: "two-sentence loop",
    text: "Why are we doing this later? Okay, hold on. ".repeat(24).trim(),
  },
  {
    name: "three-sentence block loop",
    text: "First point. Second point. Third point. ".repeat(16).trim(),
  },
];

/** Read a fragmented-MP4 fixture and count its moof (fragment) boxes. */
function readFixture(file: string): { bytes: Uint8Array<ArrayBuffer>; fragments: number } {
  const raw = readFileSync(fileURLToPath(new URL(`./__fixtures__/${file}`, import.meta.url)));
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);
  let i = 0;
  let fragments = 0;
  while (i + 8 <= bytes.byteLength) {
    const size = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (type === "moof") fragments += 1;
    if (size < 8) break;
    i += size;
  }
  return { bytes, fragments };
}

describe("finalizeInPersonMeeting regression — fragmentation lengths", () => {
  beforeEach(() => {
    process.env.LOVABLE_API_KEY = "test-key";
    state.updates = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/audio/transcriptions")) {
          return new Response(JSON.stringify({ text: state.transcriptResponse }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      }),
    );
  });

  for (const fixture of FRAGMENTATION_FIXTURES) {
    it(`fixture has the expected fragment count: ${fixture.name}`, () => {
      const { bytes, fragments } = readFixture(fixture.file);
      expect(bytes.byteLength).toBeGreaterThan(1000);
      expect(fragments).toBe(fixture.fragments);
    });

    for (const pattern of RUNAWAY_PATTERNS) {
      it(`prevents runaway repetition — ${fixture.name} + ${pattern.name}`, async () => {
        const { bytes } = readFixture(fixture.file);
        state.sampleBytes = bytes;
        state.transcriptResponse = pattern.text;

        // The simulated model output really is a runaway loop.
        expect(maxConsecutiveBlockRepeats(pattern.text)).toBeGreaterThanOrEqual(10);

        const { finalizeInPersonMeeting } = await import("./meetings.server");
        const status = await finalizeInPersonMeeting("meeting-1");
        expect(status).toBe("done");

        const saved = state.updates.find((u) => u.status === "done");
        expect(saved, "meeting should be saved as done").toBeTruthy();

        const segments = saved!.transcript as Array<{ text: string }>;
        const savedText = segments.map((s) => s.text).join(" ");

        // Persisted transcript must not carry the loop through to the UI.
        expect(maxConsecutiveBlockRepeats(savedText)).toBeLessThanOrEqual(2);
        expect(savedText.length).toBeLessThan(pattern.text.length / 4);
      });
    }
  }
});
