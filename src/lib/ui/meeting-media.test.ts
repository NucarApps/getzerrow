import { describe, it, expect, vi, afterEach } from "vitest";
import { PLATFORM_LABEL, pickMime, platformOf } from "./meeting-media";
import { detectPlatform } from "../recall.server";

describe("platformOf", () => {
  it.each([
    ["https://acme.zoom.us/j/1234567890?pwd=abc", "zoom"],
    ["https://zoom.us/j/1234567890", "zoom"],
    ["https://meet.google.com/abc-defg-hij", "google_meet"],
    ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc", "teams"],
    ["https://teams.live.com/meet/9312345", "teams"],
    ["https://acme.webex.com/acme/j.php?MTID=m123", "webex"],
  ])("recognises %s as %s", (url, platform) => {
    expect(platformOf(url)).toBe(platform);
  });

  it.each([
    ["https://whereby.com/acme-standup"],
    ["https://example.com/not-a-meeting"],
    ["https://calendar.google.com/event?eid=abc"],
    [""],
    ["zoom"],
  ])("returns null for %s, which is not a platform it knows", (url) => {
    expect(platformOf(url)).toBeNull();
  });

  it("matches case-insensitively, so a shouty link pasted from an invite still resolves", () => {
    expect(platformOf("HTTPS://ACME.ZOOM.US/J/123")).toBe("zoom");
    expect(platformOf("Join at MEET.GOOGLE.COM/abc-defg-hij")).toBe("google_meet");
  });

  it("finds the host inside surrounding invite prose, not just a bare URL", () => {
    expect(platformOf("Dial in: https://acme.webex.com/join or call +1 555 0100")).toBe("webex");
  });

  it("checks zoom before google_meet, so a URL naming both resolves to the first rung", () => {
    expect(platformOf("https://acme.zoom.us/j/1?ref=meet.google.com/x")).toBe("zoom");
  });

  it("labels every platform it can return, so the UI never falls through to 'meeting'", () => {
    const urls = [
      "https://zoom.us/j/1",
      "https://meet.google.com/a-b-c",
      "https://teams.live.com/meet/1",
      "https://acme.webex.com/j",
    ];
    for (const url of urls) {
      const platform = platformOf(url);
      expect(platform, url).not.toBeNull();
      expect(PLATFORM_LABEL[platform!], url).toBeTypeOf("string");
    }
    expect(Object.keys(PLATFORM_LABEL).sort()).toStrictEqual([
      "google_meet",
      "teams",
      "webex",
      "zoom",
    ]);
  });

  // The client slug indexes PLATFORM_LABEL; the server slug is sent to Recall.
  // They agree on three of four platforms and deliberately disagree on Teams,
  // so neither can be swapped for the other without breaking something.
  it("agrees with the server's detectPlatform except on the Teams slug", () => {
    const urls = [
      "https://acme.zoom.us/j/1",
      "https://meet.google.com/a-b-c",
      "https://acme.webex.com/j",
      "https://example.com/nope",
    ];
    for (const url of urls) {
      expect(platformOf(url), url).toBe(detectPlatform(url));
    }
    expect(platformOf("https://teams.microsoft.com/l/meetup-join/1")).toBe("teams");
    expect(detectPlatform("https://teams.microsoft.com/l/meetup-join/1")).toBe("microsoft_teams");
  });
});

/**
 * Stand in for the browser's MediaRecorder with a fixed support set. Passing
 * `undefined` removes the global entirely (SSR, and any runtime with no
 * recorder at all).
 */
function stubRecorder(supported: string[] | undefined): string[] {
  const asked: string[] = [];
  if (supported === undefined) {
    vi.stubGlobal("MediaRecorder", undefined);
    return asked;
  }
  vi.stubGlobal("MediaRecorder", {
    isTypeSupported: (type: string) => {
      asked.push(type);
      return supported.includes(type);
    },
  });
  return asked;
}

const VIDEO_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const AUDIO_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm"];

describe("pickMime", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the first supported candidate, in the order given", () => {
    stubRecorder(VIDEO_CANDIDATES);
    expect(pickMime(VIDEO_CANDIDATES, "video/webm")).toBe("video/webm;codecs=vp9,opus");
  });

  it("skips candidates the browser rejects and takes the next one", () => {
    stubRecorder(["video/webm;codecs=vp8,opus", "video/webm"]);
    expect(pickMime(VIDEO_CANDIDATES, "video/webm")).toBe("video/webm;codecs=vp8,opus");
  });

  it("stops asking once a candidate is accepted", () => {
    const asked = stubRecorder(["video/webm;codecs=vp8,opus", "video/webm"]);
    pickMime(VIDEO_CANDIDATES, "video/webm");
    expect(asked).toStrictEqual(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"]);
  });

  it("falls back only after every candidate has been offered", () => {
    const asked = stubRecorder([]);
    expect(pickMime(VIDEO_CANDIDATES, "video/mp4")).toBe("video/mp4");
    expect(asked).toStrictEqual(VIDEO_CANDIDATES);
  });

  // The iOS path: Safari's MediaRecorder exists but supports no WebM, so the
  // recorder is constructed with the fallback container. A regression here
  // hands MediaRecorder a mimeType it rejects and the recording never starts.
  it("returns the fallback when the recorder exists but supports nothing offered", () => {
    stubRecorder(["video/mp4;codecs=avc1", "audio/mp4"]);
    expect(pickMime(VIDEO_CANDIDATES, "video/webm")).toBe("video/webm");
    expect(pickMime(AUDIO_CANDIDATES, "audio/webm")).toBe("audio/webm");
  });

  it("returns the fallback without touching the global when MediaRecorder is absent", () => {
    stubRecorder(undefined);
    expect(pickMime(VIDEO_CANDIDATES, "video/webm")).toBe("video/webm");
    expect(pickMime(AUDIO_CANDIDATES, "audio/webm")).toBe("audio/webm");
  });

  it("returns the fallback for an empty candidate list", () => {
    stubRecorder(["video/webm"]);
    expect(pickMime([], "video/webm")).toBe("video/webm");
  });

  it("picks the opus audio track when it is available", () => {
    stubRecorder(["audio/webm;codecs=opus", "audio/webm"]);
    expect(pickMime(AUDIO_CANDIDATES, "audio/webm")).toBe("audio/webm;codecs=opus");
  });

  it("does not fall through to the fallback when the last candidate is the only match", () => {
    stubRecorder(["audio/webm"]);
    expect(pickMime(AUDIO_CANDIDATES, "audio/ogg")).toBe("audio/webm");
  });
});
