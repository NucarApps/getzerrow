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

  it("compares multibyte text by its bytes, not its appearance", () => {
    const nfc = "caf\u00e9"; // e-acute as one code point
    const nfd = "cafe\u0301"; // e + combining acute -- renders identically
    expect(nfc).not.toBe(nfd);

    expect(constantTimeEqual(nfc, nfc)).toBe(true);
    // Two strings a human cannot tell apart must still not open a gate: a
    // secret is bytes, and normalizing before comparing would let a
    // visually identical value through.
    expect(constantTimeEqual(nfc, nfd)).toBe(false);
    expect(constantTimeEqual("na\u00efve", "naive")).toBe(false);
  });
});
