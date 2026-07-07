import { describe, it, expect } from "vitest";
import {
  isTransientWriteError,
  backoffDelayMs,
  resolveRetryConfig,
  DEFAULT_RETRY_CONFIG,
} from "./folder-write-retry";

describe("isTransientWriteError", () => {
  it("treats connection / deadlock / resource SQLSTATEs as transient", () => {
    for (const code of ["08006", "40001", "40P01", "53300", "55P03", "57014", "57P03"]) {
      expect(isTransientWriteError({ code })).toBe(true);
    }
  });

  it("treats schema/constraint SQLSTATEs as permanent", () => {
    for (const code of ["42703", "42P01", "42883", "23505", "23502"]) {
      expect(isTransientWriteError({ code })).toBe(false);
    }
  });

  it("matches network-style messages when no code is present", () => {
    expect(isTransientWriteError({ message: "fetch failed" })).toBe(true);
    expect(isTransientWriteError({ message: "Connection terminated unexpectedly" })).toBe(true);
    expect(isTransientWriteError(new Error("ETIMEDOUT connecting to db"))).toBe(true);
  });

  it("treats unknown coded errors and plain messages as permanent", () => {
    expect(isTransientWriteError({ code: "99999" })).toBe(false);
    expect(isTransientWriteError({ message: "permission denied for table" })).toBe(false);
    expect(isTransientWriteError(null)).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially with attempt (deterministic jitter)", () => {
    // rand = 1 → full delay (exp), rand = 0 → half delay (exp/2)
    expect(backoffDelayMs(1, { baseMs: 100, rand: 1 })).toBe(100);
    expect(backoffDelayMs(2, { baseMs: 100, rand: 1 })).toBe(200);
    expect(backoffDelayMs(3, { baseMs: 100, rand: 1 })).toBe(400);
    expect(backoffDelayMs(1, { baseMs: 100, rand: 0 })).toBe(50);
  });

  it("caps the pre-jitter delay at maxMs", () => {
    expect(backoffDelayMs(10, { baseMs: 100, maxMs: 800, rand: 1 })).toBe(800);
  });

  it("never returns zero", () => {
    expect(backoffDelayMs(1, { baseMs: 100, rand: 0 })).toBeGreaterThan(0);
  });
});

describe("resolveRetryConfig", () => {
  it("falls back to defaults when env vars are unset", () => {
    expect(resolveRetryConfig({})).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it("reads max attempts and backoff base from the environment", () => {
    expect(
      resolveRetryConfig({
        FOLDER_WRITE_MAX_ATTEMPTS: "5",
        FOLDER_WRITE_BACKOFF_BASE_MS: "250",
      }),
    ).toEqual({ maxAttempts: 5, baseMs: 250 });
  });

  it("clamps out-of-range values to the safety rails", () => {
    expect(
      resolveRetryConfig({
        FOLDER_WRITE_MAX_ATTEMPTS: "999",
        FOLDER_WRITE_BACKOFF_BASE_MS: "999999",
      }),
    ).toEqual({ maxAttempts: 10, baseMs: 60_000 });

    expect(
      resolveRetryConfig({
        FOLDER_WRITE_MAX_ATTEMPTS: "0",
        FOLDER_WRITE_BACKOFF_BASE_MS: "0",
      }),
    ).toEqual({ maxAttempts: 1, baseMs: 1 });
  });

  it("ignores invalid (non-integer / empty) values and uses defaults", () => {
    for (const bad of ["", "  ", "abc", "1.5", "NaN"]) {
      expect(resolveRetryConfig({ FOLDER_WRITE_MAX_ATTEMPTS: bad })).toEqual(DEFAULT_RETRY_CONFIG);
    }
  });
});
