import { describe, expect, it, vi } from "vitest";
import {
  describeDiagnostic,
  emptyAccountsMessage,
  requeuedMessage,
  watchStatus,
  WATCH_EXPIRING_MS,
  type DiagnosticResult,
} from "./account-health";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("watchStatus", () => {
  it("reports a watch with days left as renewing normally", () => {
    expect(watchStatus(iso(6 * 24 * 3_600_000), NOW)).toStrictEqual({
      state: "renews",
      healthy: true,
    });
  });

  it.each([
    ["a day and a millisecond out — still just renewing", WATCH_EXPIRING_MS + 1, "renews"],
    ["exactly a day out — still just renewing", WATCH_EXPIRING_MS, "renews"],
    ["a millisecond inside the day — expiring", WATCH_EXPIRING_MS - 1, "expiring"],
    ["an hour out — expiring", 3_600_000, "expiring"],
    ["a millisecond out — expiring, not yet expired", 1, "expiring"],
  ] as const)("calls %s", (_label, offset, state) => {
    expect(watchStatus(iso(offset), NOW)).toStrictEqual({ state, healthy: true });
  });

  it.each([
    ["exactly now — expired, because the watch is no longer in the future", 0],
    ["a millisecond ago", -1],
    ["a week ago", -7 * 24 * 3_600_000],
  ])("calls %s expired and unhealthy", (_label, offset) => {
    expect(watchStatus(iso(offset), NOW)).toStrictEqual({ state: "expired", healthy: false });
  });

  it.each([
    ["a null expiry", null],
    ["an undefined expiry", undefined],
    ["an empty string", ""],
  ])("treats %s as no live watch rather than as a healthy one", (_label, value) => {
    expect(watchStatus(value, NOW)).toStrictEqual({ state: "expired", healthy: false });
  });

  it("treats an unparseable timestamp as expired rather than as renewing", () => {
    // NaN compares false against everything, so the guard has to be written
    // as "not greater than now" — the naive "expiry <= now" test would call
    // this healthy.
    expect(watchStatus("not a date", NOW)).toStrictEqual({ state: "expired", healthy: false });
  });

  it("does not read the wall clock — the same expiry ages as `now` advances", () => {
    const expiry = iso(2 * 24 * 3_600_000);
    expect(watchStatus(expiry, NOW).state).toBe("renews");
    expect(watchStatus(expiry, NOW + 25 * 3_600_000).state).toBe("expiring");
    expect(watchStatus(expiry, NOW + 3 * 24 * 3_600_000).state).toBe("expired");
  });
});

describe("describeDiagnostic", () => {
  const fmt = (s: string) => `formatted(${s})`;

  function result(over: Partial<DiagnosticResult> = {}): DiagnosticResult {
    return { accessToken: "ok", watch: "active", ...over };
  }

  it("asks for a reconnect and quotes the reason", () => {
    expect(
      describeDiagnostic(result({ accessToken: "needs_reconnect", error: "invalid_grant" }), fmt),
    ).toStrictEqual({
      kind: "needs_reconnect",
      message: "Reconnect required: invalid_grant",
    });
  });

  it("names a generic reason when the reconnect carries no error text", () => {
    expect(
      describeDiagnostic(result({ accessToken: "needs_reconnect", error: null }), fmt).message,
    ).toBe("Reconnect required: OAuth token expired");
  });

  it("prefers the reconnect verdict over a failing watch", () => {
    // A dead token explains the dead watch; telling the user about the watch
    // would send them to the wrong fix.
    expect(
      describeDiagnostic(
        result({ accessToken: "needs_reconnect", watch: "error", error: "invalid_grant" }),
        fmt,
      ).kind,
    ).toBe("needs_reconnect");
  });

  it.each([
    ["the token check errored", { accessToken: "error" }],
    ["the watch check errored", { watch: "error" }],
  ])("reports an error when %s", (_label, over) => {
    expect(describeDiagnostic(result({ ...over, error: "boom" }), fmt)).toStrictEqual({
      kind: "error",
      message: "boom",
    });
  });

  it("falls back to a generic failure when an error carries no message", () => {
    expect(describeDiagnostic(result({ watch: "error" }), fmt).message).toBe("Diagnostic failed");
  });

  it("reports success with the watch state and its formatted expiry", () => {
    expect(
      describeDiagnostic(result({ watch: "active", watchExpiresAt: "2026-09-08T00:00:00Z" }), fmt),
    ).toStrictEqual({
      kind: "ok",
      message: "OAuth ok · watch active · formatted(2026-09-08T00:00:00Z)",
    });
  });

  it("omits the expiry clause when the watch has no expiry", () => {
    const formatExpiry = vi.fn(fmt);
    expect(
      describeDiagnostic(result({ watch: "missing", watchExpiresAt: null }), formatExpiry),
    ).toStrictEqual({ kind: "ok", message: "OAuth ok · watch missing" });
    expect(formatExpiry).not.toHaveBeenCalled();
  });

  it("still reports success for a watch state that is unusual but not an error", () => {
    expect(describeDiagnostic(result({ watch: "missing" }), fmt).kind).toBe("ok");
  });
});

describe("emptyAccountsMessage", () => {
  it("tells a user with nothing connected to connect an account", () => {
    expect(emptyAccountsMessage(0)).toBe("No Gmail accounts connected yet.");
  });

  it("tells a user whose filter matched nothing to pick an inbox", () => {
    expect(emptyAccountsMessage(2)).toBe("Pick an inbox above to see its status.");
  });
});

describe("requeuedMessage", () => {
  it.each([
    [0, "Requeued 0 failed jobs"],
    [1, "Requeued 1 failed job"],
    [2, "Requeued 2 failed jobs"],
    [11, "Requeued 11 failed jobs"],
  ])("pluralises %i as %s", (n, expected) => {
    expect(requeuedMessage(n)).toBe(expected);
  });
});
