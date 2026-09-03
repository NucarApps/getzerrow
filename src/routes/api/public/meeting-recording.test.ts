// Contract for the public recording stream proxy. The HMAC gate is exercised
// through the REAL meeting-stream.server signer — a test that stubs the
// verifier would prove nothing about the tokens the app actually mints — and
// only the recording lookup is faked.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRecordingStreamPath } from "@/lib/meeting-stream.server";
import { handler } from "./__fixtures__/route-harness";
import { Route } from "./meeting-recording";

const resolvePlayableRecordingUrl = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings.server").resolvePlayableRecordingUrl>(),
);
const mintFreshRecordingUrl = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings.server").mintFreshRecordingUrl>(),
);
vi.mock("@/lib/meetings.server", () => ({ resolvePlayableRecordingUrl, mintFreshRecordingUrl }));

const GET = handler(Route, "GET");

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const SECRET = "meeting-stream-secret";
const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const STORED_URL = "https://recall.test/recordings/abc.mp4";

let fetchMock: ReturnType<typeof vi.fn>;

/** A signed request for the meeting, with any extra query params. */
function signedRequest(extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const path = buildRecordingStreamPath(MEETING_ID);
  const url = new URL(`https://atzro.test${path}`);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

function upstream(body: string, init: ResponseInit = {}) {
  return new Response(body, init);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("MEETING_STREAM_SECRET", SECRET);
  resolvePlayableRecordingUrl.mockResolvedValue({
    url: STORED_URL,
    recallBotId: "bot-1",
    contentType: "video/mp4",
    filename: "weekly-sync.mp4",
  });
  mintFreshRecordingUrl.mockResolvedValue(null);
  fetchMock = vi.fn(async () => upstream("bytes", { headers: { "content-length": "5" } }));
  vi.stubGlobal("fetch", fetchMock);
});

describe("the HMAC gate", () => {
  it("streams the recording for a freshly minted token", async () => {
    const res = await GET({ request: signedRequest(), params: {} });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes");
    expect(fetchMock).toHaveBeenCalledWith(STORED_URL, { headers: {} });
  });

  it("refuses a tampered signature", async () => {
    const req = signedRequest({ t: "not-the-signature" });

    const res = await GET({ request: req, params: {} });

    expect(res.status).toBe(401);
    expect(resolvePlayableRecordingUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a token re-pointed at a different meeting", async () => {
    const req = signedRequest({ m: "22222222-2222-4222-8222-222222222222" });

    const res = await GET({ request: req, params: {} });

    expect(res.status).toBe(401);
  });

  it("refuses a token whose expiry has passed", async () => {
    const req = signedRequest();
    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);

    const res = await GET({ request: req, params: {} });

    expect(res.status).toBe(401);
  });

  it("refuses a request with no token at all", async () => {
    const res = await GET({
      request: new Request(`https://atzro.test/api/public/meeting-recording?m=${MEETING_ID}`),
      params: {},
    });

    expect(res.status).toBe(401);
  });

  it("answers 401, not 500, when the signing secret is not configured", async () => {
    const req = signedRequest();
    vi.stubEnv("MEETING_STREAM_SECRET", undefined);

    const res = await GET({ request: req, params: {} });

    // Signing to compare used to throw out of a handler with no try/catch,
    // so a deployment missing the secret announced itself with a 500.
    expect(res.status).toBe(401);
  });
});

describe("resolving the recording", () => {
  it("returns 404 when the meeting has no playable recording", async () => {
    resolvePlayableRecordingUrl.mockResolvedValue({
      url: null,
      recallBotId: null,
      contentType: "video/mp4",
      filename: "x.mp4",
    });

    const res = await GET({ request: signedRequest(), params: {} });

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Recording not available");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades to 404 rather than 500 when the lookup itself throws", async () => {
    resolvePlayableRecordingUrl.mockRejectedValue(new Error("db down"));

    const res = await GET({ request: signedRequest(), params: {} });

    expect(res.status).toBe(404);
  });
});

describe("response headers", () => {
  it("serves the resolved content type with no-store caching", async () => {
    resolvePlayableRecordingUrl.mockResolvedValue({
      url: STORED_URL,
      recallBotId: "bot-1",
      contentType: "audio/mpeg",
      filename: "weekly-sync.mp3",
    });

    const res = await GET({ request: signedRequest(), params: {} });

    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, no-store");
    expect(res.headers.get("Content-Length")).toBe("5");
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("offers the file as a download only when dl=1", async () => {
    const res = await GET({ request: signedRequest({ dl: "1" }), params: {} });

    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="weekly-sync.mp4"');
  });

  it("forwards the browser's Range header and mirrors the partial response", async () => {
    fetchMock.mockResolvedValue(
      upstream("part", {
        status: 206,
        headers: { "content-range": "bytes 0-3/100", "content-length": "4" },
      }),
    );

    const res = await GET({
      request: signedRequest({}, { range: "bytes=0-3" }),
      params: {},
    });

    expect(fetchMock).toHaveBeenCalledWith(STORED_URL, { headers: { Range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 0-3/100");
  });
});

describe("expired storage URLs", () => {
  it.each([403, 401])("mints a fresh URL once after upstream %i and retries", async (status) => {
    fetchMock
      .mockResolvedValueOnce(upstream("denied", { status }))
      .mockResolvedValueOnce(upstream("bytes", { headers: { "content-length": "5" } }));
    mintFreshRecordingUrl.mockResolvedValue("https://recall.test/fresh.mp4");

    const res = await GET({ request: signedRequest(), params: {} });

    expect(mintFreshRecordingUrl).toHaveBeenCalledExactlyOnceWith(MEETING_ID, "bot-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://recall.test/fresh.mp4");
    expect(res.status).toBe(200);
  });

  it("forwards the Range header on the retry too", async () => {
    fetchMock
      .mockResolvedValueOnce(upstream("denied", { status: 403 }))
      .mockResolvedValueOnce(upstream("part", { status: 206 }));
    mintFreshRecordingUrl.mockResolvedValue("https://recall.test/fresh.mp4");

    await GET({ request: signedRequest({}, { range: "bytes=10-20" }), params: {} });

    expect(fetchMock.mock.calls[1]?.[1]).toStrictEqual({ headers: { Range: "bytes=10-20" } });
  });

  it("does not re-mint for an account with no Recall bot", async () => {
    resolvePlayableRecordingUrl.mockResolvedValue({
      url: STORED_URL,
      recallBotId: null,
      contentType: "video/mp4",
      filename: "x.mp4",
    });
    fetchMock.mockResolvedValue(upstream("denied", { status: 403 }));

    const res = await GET({ request: signedRequest(), params: {} });

    expect(mintFreshRecordingUrl).not.toHaveBeenCalled();
    expect(res.status).toBe(502);
  });

  it("reports 502 when there is no fresh URL to be had", async () => {
    fetchMock.mockResolvedValue(upstream("denied", { status: 403 }));
    mintFreshRecordingUrl.mockResolvedValue(null);

    const res = await GET({ request: signedRequest(), params: {} });

    expect(res.status).toBe(502);
    expect(await res.text()).toBe("Upstream fetch failed");
  });

  it("reports 502 when minting itself throws", async () => {
    fetchMock.mockResolvedValue(upstream("denied", { status: 403 }));
    mintFreshRecordingUrl.mockRejectedValue(new Error("recall 500"));

    const res = await GET({ request: signedRequest(), params: {} });

    expect(res.status).toBe(502);
  });

  it("reports 502 for any other upstream failure without re-minting", async () => {
    fetchMock.mockResolvedValue(upstream("boom", { status: 500 }));

    const res = await GET({ request: signedRequest(), params: {} });

    expect(mintFreshRecordingUrl).not.toHaveBeenCalled();
    expect(res.status).toBe(502);
  });
});
