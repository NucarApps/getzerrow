import { describe, it, expect } from "vitest";
import { isTransientWriteError, backoffDelayMs } from "./folder-write-retry";

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
