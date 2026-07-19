import { describe, it, expect } from "vitest";
import { fingerprintSecret, redactSearch, redactedEndpoint } from "./pubsub-redact";

const SECRET = "super-secret-webhook-token-12345";

describe("fingerprintSecret", () => {
  it("handles missing values", () => {
    expect(fingerprintSecret(null)).toBe("(none)");
    expect(fingerprintSecret(undefined)).toBe("(none)");
    expect(fingerprintSecret("")).toBe("(none)");
  });

  it("never reveals short secrets", () => {
    expect(fingerprintSecret("abcd")).toBe("(len 4)");
  });

  it("shows only edges and length for real secrets", () => {
    const fp = fingerprintSecret(SECRET);
    expect(fp).toBe(`su…45 (len ${SECRET.length})`);
    expect(fp).not.toContain(SECRET);
    expect(fp).not.toContain(SECRET.slice(2, -2));
  });
});

describe("redactSearch", () => {
  it("returns empty string for empty search", () => {
    expect(redactSearch("")).toBe("");
    expect(redactSearch("?")).toBe("");
  });

  it("passes non-secret params through unchanged", () => {
    expect(redactSearch("?foo=bar&page=2")).toBe("?foo=bar&page=2");
  });

  it.each(["token", "secret", "key", "apikey", "api_key", "TOKEN"])(
    "redacts the %s param",
    (name) => {
      const out = redactSearch(`?${name}=${SECRET}`);
      expect(out).not.toContain(SECRET);
      expect(out).toContain(`${name}=<redacted:`);
    },
  );

  it("redacts secrets while keeping neighbors readable", () => {
    const out = redactSearch(`?a=1&token=${SECRET}&b=2`);
    expect(out).toContain("a=1");
    expect(out).toContain("b=2");
    expect(out).not.toContain(SECRET);
  });
});

describe("redactedEndpoint", () => {
  it("keeps the pathname and strips the secret", () => {
    const url = new URL(`https://getzerrow.com/api/public/gmail-webhook?token=${SECRET}`);
    const out = redactedEndpoint(url);
    expect(out.startsWith("/api/public/gmail-webhook?token=<redacted:")).toBe(true);
    expect(out).not.toContain(SECRET);
  });

  it("is a plain path when there is no query", () => {
    const url = new URL("https://getzerrow.com/api/public/gmail-webhook");
    expect(redactedEndpoint(url)).toBe("/api/public/gmail-webhook");
  });
});
