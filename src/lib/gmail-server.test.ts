// Unit tests for the Gmail HTTP client's error layer (src/lib/gmail.server.ts).
// Every sync lane and write-back path routes through `gmailFetch`, so the
// GmailApiError taxonomy IS the retry policy: `retryable` decides whether a
// job is retried or dead-lettered, `retryAfterSeconds` schedules 429 backoff,
// and `isQuotaExceeded` (daily cap only) switches to the midnight-PT quota
// wait. Quota/rate-limit errors arrive on 403 as well as 429. These tests pin
// that mapping, plus the chunking/encoding invariants of the batch and send
// endpoints.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

vi.mock("./google-oauth.server", () => ({
  getAccessToken: vi.fn(async () => "tok"),
}));

import {
  GmailApiError,
  listLabels,
  stopWatch,
  getMessageLabels,
  batchModifyMessages,
  sendMessage,
  ensureWatch,
} from "./gmail.server";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const savedTopic = process.env.GMAIL_PUBSUB_TOPIC;

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

async function captureError(promise: Promise<unknown>): Promise<GmailApiError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(GmailApiError);
    return e as GmailApiError;
  }
  throw new Error("Expected GmailApiError to be thrown");
}

beforeEach(() => {
  fetchMock.mockReset();
  delete process.env.GMAIL_PUBSUB_TOPIC;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (savedTopic === undefined) delete process.env.GMAIL_PUBSUB_TOPIC;
  else process.env.GMAIL_PUBSUB_TOPIC = savedTopic;
});

describe("GmailApiError status mapping", () => {
  it("maps a 500 to a retryable error carrying status and body excerpt", async () => {
    fetchMock.mockResolvedValueOnce(new Response("backend melted", { status: 500 }));
    const err = await captureError(listLabels("acc-1"));
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBeNull();
    expect(err.isQuotaExceeded).toBe(false);
    expect(err.message).toContain("500");
    expect(err.message).toContain("backend melted");
  });

  it("maps a 400 to a non-retryable error (bad requests must not loop)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const err = await captureError(listLabels("acc-1"));
    expect(err.status).toBe(400);
    expect(err.retryable).toBe(false);
    expect(err.isQuotaExceeded).toBe(false);
  });

  it("sends the OAuth token as a Bearer Authorization header", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ labels: [] }));
    await listLabels("acc-1");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });
});

describe("Retry-After parsing (429 only)", () => {
  it("parses delta-seconds on a 429", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }),
    );
    const err = await captureError(listLabels("acc-1"));
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(120);
  });

  it("parses an HTTP-date into whole seconds from now", async () => {
    // Fixed clock with zero ms so the toUTCString() second-truncation is exact.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00.000Z"));
    const header = new Date(Date.now() + 90_000).toUTCString();
    fetchMock.mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": header } }),
    );
    const err = await captureError(listLabels("acc-1"));
    expect(err.retryAfterSeconds).toBe(90);
  });

  it("returns null for garbage values instead of mis-parsing them", async () => {
    // "120 seconds" would slip through a bare parseInt — the strict /^\d+$/
    // guard must reject it, along with plain junk and non-positive values.
    for (const bad of ["120 seconds", "soon", "0"]) {
      fetchMock.mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": bad } }),
      );
      const err = await captureError(listLabels("acc-1"));
      expect(err.retryAfterSeconds).toBeNull();
    }
  });

  it("ignores Retry-After on non-429 statuses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unavailable", { status: 503, headers: { "Retry-After": "60" } }),
    );
    const err = await captureError(listLabels("acc-1"));
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBeNull();
  });
});

describe("rate-limit + quota classification", () => {
  // Gmail surfaces per-user throttling as BOTH 429 and 403. Policy: any
  // quota/rate-limit reason (on 429 or 403) is retryable, but only the DAILY
  // cap (`dailyLimitExceeded`) sets isQuotaExceeded → the midnight-PT wait.
  // Per-100s flow limits clear in seconds and must use the short backoff table.
  function quotaResponse(reason: string, status: number, headers?: Record<string, string>) {
    return new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status, headers });
  }

  it("treats flow-rate reasons on a 429 as retryable but NOT a daily-quota wait", async () => {
    for (const reason of ["quotaExceeded", "userRateLimitExceeded", "rateLimitExceeded"]) {
      fetchMock.mockResolvedValueOnce(quotaResponse(reason, 429));
      const err = await captureError(listLabels("acc-1"));
      expect(err.retryable).toBe(true);
      expect(err.isQuotaExceeded).toBe(false);
    }
  });

  it("flags only dailyLimitExceeded as isQuotaExceeded (midnight-PT reset)", async () => {
    fetchMock.mockResolvedValueOnce(quotaResponse("dailyLimitExceeded", 429));
    const err = await captureError(listLabels("acc-1"));
    expect(err.retryable).toBe(true);
    expect(err.isQuotaExceeded).toBe(true);
  });

  it("classifies a quota/rate-limit 403 as retryable, not a terminal auth failure", async () => {
    // Gmail returns per-user throttling as 403 as well as 429. A bare 403 is
    // terminal (next test), but a 403 whose body carries a quota reason is
    // transient and MUST go through backoff rather than dead-lettering the job.
    for (const reason of ["userRateLimitExceeded", "rateLimitExceeded"]) {
      fetchMock.mockResolvedValueOnce(quotaResponse(reason, 403));
      const err = await captureError(listLabels("acc-1"));
      expect(err.status).toBe(403);
      expect(err.retryable).toBe(true);
      expect(err.isQuotaExceeded).toBe(false);
    }
    // A daily-cap 403 is retryable AND routes to the midnight wait.
    fetchMock.mockResolvedValueOnce(quotaResponse("dailyLimitExceeded", 403));
    const dailyErr = await captureError(listLabels("acc-1"));
    expect(dailyErr.retryable).toBe(true);
    expect(dailyErr.isQuotaExceeded).toBe(true);
  });

  it("keeps a bare 403 terminal (genuine auth/permission failure)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("insufficient permissions", { status: 403 }));
    const err = await captureError(listLabels("acc-1"));
    expect(err.status).toBe(403);
    expect(err.retryable).toBe(false);
    expect(err.isQuotaExceeded).toBe(false);
  });

  it("parses Retry-After on a rate-limited 403", async () => {
    fetchMock.mockResolvedValueOnce(
      quotaResponse("userRateLimitExceeded", 403, { "Retry-After": "45" }),
    );
    const err = await captureError(listLabels("acc-1"));
    expect(err.retryAfterSeconds).toBe(45);
  });

  it("does not flag quota on a 500 even when the body mentions it", async () => {
    fetchMock.mockResolvedValueOnce(quotaResponse("quotaExceeded", 500));
    const err = await captureError(listLabels("acc-1"));
    expect(err.retryable).toBe(true); // 500 is retryable on its own merits
    expect(err.isQuotaExceeded).toBe(false);
  });
});

describe("network failures", () => {
  it("wraps a fetch rejection as status 0, retryable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const err = await captureError(listLabels("acc-1"));
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("network error");
    expect(err.message).toContain("fetch failed");
  });

  it("wraps an AbortSignal timeout as status 0, retryable, with a timeout message", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    const err = await captureError(listLabels("acc-1"));
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("timeout");
  });
});

describe("response body handling", () => {
  it("returns {} for an empty 200 body (Gmail's modify/stop endpoints)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(stopWatch("acc-1")).resolves.toEqual({});
  });
});

describe("getMessageLabels", () => {
  it("returns null on 404 (message gone) so callers can treat it as deleted", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await expect(getMessageLabels("acc-1", "m-1")).resolves.toBeNull();
  });

  it("rethrows non-404 errors", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    const err = await captureError(getMessageLabels("acc-1", "m-1"));
    expect(err.status).toBe(500);
  });

  it("normalizes a missing labelIds field to an empty array", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "m-1" }));
    await expect(getMessageLabels("acc-1", "m-1")).resolves.toEqual([]);
  });
});

describe("batchModifyMessages", () => {
  it("chunks >1000 ids into multiple batchModify calls and sums the total", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 200 }));
    const ids = Array.from({ length: 1500 }, (_, i) => `m-${i}`);
    const processed = await batchModifyMessages("acc-1", ids, ["ADD"], ["REM"]);
    expect(processed).toBe(1500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string) as { ids: string[] },
    );
    expect(bodies[0].ids).toHaveLength(1000);
    expect(bodies[1].ids).toHaveLength(500);
    expect(bodies[0].ids[0]).toBe("m-0");
    expect(bodies[1].ids[0]).toBe("m-1000");
  });

  it("makes zero API calls for an empty id list", async () => {
    await expect(batchModifyMessages("acc-1", [])).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendMessage", () => {
  it("encodes the RFC 822 payload as unpadded base64url", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "sent-1" }));
    await sendMessage("acc-1", "to@x.com", "Hi", "body text");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      raw: string;
      threadId?: string;
    };
    // base64url alphabet only, no padding.
    expect(body.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("To: to@x.com");
    expect(decoded).toContain("Subject: Hi");
    // RFC 822: headers and body must be separated by an empty line, or the
    // receiving parser treats the first body line as a malformed header.
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"\r\n\r\nbody text');
    // No threadId and no threading headers on a fresh send.
    expect(body.threadId).toBeUndefined();
    expect(decoded).not.toContain("In-Reply-To");
    expect(decoded).not.toContain("References");
  });

  it("adds In-Reply-To/References headers and threadId only when replying", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "sent-2" }));
    await sendMessage("acc-1", "to@x.com", "Re: Hi", "reply", "thread-9", "<msg-id@x.com>");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as {
      raw: string;
      threadId?: string;
    };
    expect(body.threadId).toBe("thread-9");
    const decoded = Buffer.from(body.raw, "base64url").toString("utf-8");
    expect(decoded).toContain("In-Reply-To: <msg-id@x.com>");
    expect(decoded).toContain("References: <msg-id@x.com>");
  });
});

describe("ensureWatch", () => {
  it("does nothing without a configured Pub/Sub topic", async () => {
    await expect(ensureWatch("acc-1", null)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips renewal when the watch has more than 3 days remaining", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    const farOut = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
    await expect(ensureWatch("acc-1", farOut)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-watches with the configured topic when expiry is near (or absent)", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/p/topics/t";
    fetchMock.mockImplementation(async () => jsonResponse({ historyId: "h1", expiration: "e1" }));

    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await expect(ensureWatch("acc-1", soon)).resolves.toEqual({
      historyId: "h1",
      expiration: "e1",
    });
    // No recorded expiration at all → also re-watch.
    await ensureWatch("acc-1", null);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/users/me/watch");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      topicName: "projects/p/topics/t",
    });
  });
});
