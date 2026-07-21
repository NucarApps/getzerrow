// The auto-DLQ-replay cron only re-queues jobs whose `last_error` looks
// transient (network/quota/5xx). Permanent failures (4xx auth, bad
// payload, parse errors) must stay parked so we don't burn quota looping.
import { describe, it, expect } from "vitest";
import { isTransientDlqError } from "./sync.server";

describe("isTransientDlqError", () => {
  it("matches Gmail 5xx server errors", () => {
    expect(isTransientDlqError("Gmail API 500 on /users/me/messages/abc: server error")).toBe(true);
    expect(isTransientDlqError("Gmail API 502 on /users/me/messages/abc: bad gateway")).toBe(true);
    expect(isTransientDlqError("Gmail API 503 on /users/me/messages/abc: unavailable")).toBe(true);
  });

  it("matches 429 rate limits", () => {
    expect(isTransientDlqError("Gmail API 429 on /users/me/messages/abc: quota exceeded")).toBe(
      true,
    );
  });

  it("matches timeout messages", () => {
    expect(isTransientDlqError("Gmail API timeout on /users/me/messages/abc (>20000ms)")).toBe(
      true,
    );
    expect(isTransientDlqError("job timeout after 25000ms (fetch=22000 ai=0 db=200)")).toBe(true);
  });

  it("matches connection-level errors", () => {
    expect(isTransientDlqError("network error: ECONNRESET on host")).toBe(true);
    expect(isTransientDlqError("ETIMEDOUT")).toBe(true);
    expect(isTransientDlqError("fetch failed")).toBe(true);
  });

  it("matches stuck-worker-timeout DLQ entries so the reclaim backlog drains", () => {
    expect(isTransientDlqError("stuck (worker timeout — exceeded max attempts)")).toBe(true);
  });

  it("matches Google 'unavailable' responses regardless of case", () => {
    expect(isTransientDlqError("Service Unavailable")).toBe(true);
    expect(isTransientDlqError("service unavailable")).toBe(true);
  });

  it("matches quota/rate-limit reasons even when Gmail reports them as 403", () => {
    expect(
      isTransientDlqError(
        'Gmail API 403 on /users/me/messages/abc: {"reason":"userRateLimitExceeded"}',
      ),
    ).toBe(true);
    expect(
      isTransientDlqError(
        'Gmail API 403 on /users/me/messages/abc: {"reason":"rateLimitExceeded"}',
      ),
    ).toBe(true);
    expect(
      isTransientDlqError('Gmail API 403 on /users/me/messages/abc: {"reason":"quotaExceeded"}'),
    ).toBe(true);
    expect(
      isTransientDlqError(
        'Gmail API 403 on /users/me/messages/abc: {"reason":"dailyLimitExceeded"}',
      ),
    ).toBe(true);
  });

  it("does NOT match permanent 4xx errors (auth, bad request)", () => {
    expect(isTransientDlqError("Gmail API 400 on /users/me/messages/abc: bad request")).toBe(false);
    expect(
      isTransientDlqError("Gmail API 401 on /users/me/messages/abc: invalid credentials"),
    ).toBe(false);
    expect(isTransientDlqError("Gmail API 403 on /users/me/messages/abc: insufficient scope")).toBe(
      false,
    );
    expect(isTransientDlqError("Gmail API 404 on /users/me/messages/abc: not found")).toBe(false);
  });

  it("does NOT match parser / classifier errors", () => {
    expect(isTransientDlqError("classify failed: Invalid JSON in AI response")).toBe(false);
    expect(isTransientDlqError("insert email failed: unique constraint violated")).toBe(false);
  });

  it("returns false for empty / null / non-string input", () => {
    expect(isTransientDlqError(null)).toBe(false);
    expect(isTransientDlqError(undefined)).toBe(false);
    expect(isTransientDlqError("")).toBe(false);
    // @ts-expect-error — runtime guard against non-string callers.
    expect(isTransientDlqError(123)).toBe(false);
  });

  it("does not match 5xx-looking digits inside larger numbers", () => {
    // \b5\d{2}\b requires word boundaries — "5000" or "1500" don't trip it.
    expect(isTransientDlqError("processed 5000 emails successfully")).toBe(false);
    expect(isTransientDlqError("offset=1500")).toBe(false);
  });

  it("flags errors with auto-replayed prefix as still transient if the underlying error is", () => {
    // After our cron re-queues a job, last_error becomes
    // "auto-replayed from DLQ at <ts> (was: Gmail API 500 ...)" — if it fails
    // again with the same error, we want to recognize it as transient again.
    expect(
      isTransientDlqError(
        "auto-replayed from DLQ at 2026-05-25T12:00:00Z (was: Gmail API 500: server error)",
      ),
    ).toBe(true);
  });
});
