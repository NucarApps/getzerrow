// Unit tests for the meeting-recording stream token
// (src/lib/meeting-stream.server.ts). This HMAC is the ONLY thing standing
// between an unauthenticated request and a meeting recording, so the
// contracts are: a freshly built path verifies, and every mutation of it
// (expiry, meeting id, secret, truncation) does not.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildRecordingStreamPath, verifyRecordingStreamToken } from "./meeting-stream.server";

const MEETING = "11111111-1111-4111-8111-111111111111";
const OTHER_MEETING = "22222222-2222-4222-8222-222222222222";

/** Pull (meetingId, exp, token) back out of a built stream path. */
function parsePath(path: string): { m: string; e: number; t: string } {
  const params = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  return {
    m: params.get("m") ?? "",
    e: Number(params.get("e")),
    t: params.get("t") ?? "",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
  vi.stubEnv("MEETING_STREAM_SECRET", "s3cret");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildRecordingStreamPath", () => {
  it("points at the public route and carries a two-hour expiry by default", () => {
    const path = buildRecordingStreamPath(MEETING);

    expect(path.startsWith("/api/public/meeting-recording?")).toBe(true);
    const { m, e } = parsePath(path);
    expect(m).toBe(MEETING);
    expect(e).toBe(Math.floor(Date.parse("2026-03-01T12:00:00Z") / 1000) + 7200);
  });

  it("refuses to mint a token when the signing secret is unset", () => {
    vi.stubEnv("MEETING_STREAM_SECRET", undefined);

    expect(() => buildRecordingStreamPath(MEETING)).toThrow(
      "MEETING_STREAM_SECRET is not configured",
    );
  });
});

describe("verifyRecordingStreamToken", () => {
  it("accepts the token it just minted", () => {
    const { m, e, t } = parsePath(buildRecordingStreamPath(MEETING));

    expect(verifyRecordingStreamToken(m, e, t)).toBe(true);
  });

  it("rejects a token once its expiry has passed", () => {
    const { m, e, t } = parsePath(buildRecordingStreamPath(MEETING, 60));

    expect(verifyRecordingStreamToken(m, e, t)).toBe(true);
    vi.setSystemTime(new Date("2026-03-01T12:01:01Z"));
    expect(verifyRecordingStreamToken(m, e, t)).toBe(false);
  });

  it("rejects a token replayed against a different meeting", () => {
    const { e, t } = parsePath(buildRecordingStreamPath(MEETING));

    expect(verifyRecordingStreamToken(OTHER_MEETING, e, t)).toBe(false);
  });

  it("rejects a token whose expiry was pushed out by the caller", () => {
    const { m, e, t } = parsePath(buildRecordingStreamPath(MEETING));

    expect(verifyRecordingStreamToken(m, e + 86_400, t)).toBe(false);
  });

  it("rejects a token minted under a different secret", () => {
    const { m, e, t } = parsePath(buildRecordingStreamPath(MEETING));
    vi.stubEnv("MEETING_STREAM_SECRET", "rotated");

    expect(verifyRecordingStreamToken(m, e, t)).toBe(false);
  });

  it("rejects missing, truncated and non-numeric inputs", () => {
    const { m, e, t } = parsePath(buildRecordingStreamPath(MEETING));

    expect([
      verifyRecordingStreamToken("", e, t),
      verifyRecordingStreamToken(m, Number.NaN, t),
      verifyRecordingStreamToken(m, e, ""),
      verifyRecordingStreamToken(m, e, t.slice(0, -1)),
      verifyRecordingStreamToken(m, e, `${t}x`),
    ]).toStrictEqual([false, false, false, false, false]);
  });

  it("fails closed when the signing secret is unset, rather than throwing", () => {
    // The route calls this outside any try/catch, so throwing here answered
    // 500 and announced the misconfiguration; refusing is the right answer.
    const { m, e, t } = parsePath(buildRecordingStreamPath(MEETING));
    vi.stubEnv("MEETING_STREAM_SECRET", undefined);

    expect(verifyRecordingStreamToken(m, e, t)).toBe(false);
  });

  // The expiry check runs before signing, so an already-expired token is
  // still rejected (not 500'd) when the secret is missing.
  it("still fails closed for an expired token when the secret is unset", () => {
    const { m, e, t } = parsePath(buildRecordingStreamPath(MEETING, 60));
    vi.setSystemTime(new Date("2026-03-01T12:01:01Z"));
    vi.stubEnv("MEETING_STREAM_SECRET", undefined);

    expect(verifyRecordingStreamToken(m, e, t)).toBe(false);
  });
});
