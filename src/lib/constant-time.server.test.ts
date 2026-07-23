import { describe, it, expect } from "vitest";
import { constantTimeEqual } from "./constant-time.server";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("s3cret-token", "s3cret-token")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for differing strings of equal length", () => {
    expect(constantTimeEqual("aaaaaa", "aaaaab")).toBe(false);
    expect(constantTimeEqual("token-A", "token-B")).toBe(false);
  });

  it("returns false for different lengths (no throw)", () => {
    expect(constantTimeEqual("short", "longer-value")).toBe(false);
    expect(constantTimeEqual("longer-value", "short")).toBe(false);
  });

  it("returns false when either side is missing", () => {
    expect(constantTimeEqual(null, "x")).toBe(false);
    expect(constantTimeEqual("x", null)).toBe(false);
    expect(constantTimeEqual(undefined, undefined)).toBe(false);
    expect(constantTimeEqual(null, null)).toBe(false);
  });

  it("handles multibyte UTF-8 without throwing or false-matching", () => {
    expect(constantTimeEqual("café", "café")).toBe(true);
    // Same JS length, different bytes — must not equal.
    expect(constantTimeEqual("café", "café".normalize("NFC") + "x".slice(0, 0))).toBe(true);
    expect(constantTimeEqual("naïve", "naive")).toBe(false);
  });
});
