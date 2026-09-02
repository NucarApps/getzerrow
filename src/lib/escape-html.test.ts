// Characterization tests for escapeHtml — the helper used to make untrusted
// text safe to interpolate into HTML we generate ourselves (card emails,
// folder-summary digests, OG images), safe in both text content and
// attribute values. Pins exactly which characters it escapes (and that it
// does NOT touch single quotes) so a future edit can't silently narrow the
// escaped set without a test failing.

import { describe, it, expect } from "vitest";
import { escapeHtml } from "./escape-html";

describe("escapeHtml", () => {
  it('escapes each of & < > " individually', () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
  });

  it("returns the empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("escapes both quote characters, so either delimiter is safe", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
    expect(escapeHtml(`say "hi"`)).toBe("say &quot;hi&quot;");
    // The payload that motivated this: a single-quoted attribute.
    expect(escapeHtml("x' onerror='alert(1)")).toBe("x&#39; onerror=&#39;alert(1)");
  });

  it("is deliberately not idempotent: escaping twice escapes the ampersands again", () => {
    // Recognising already-escaped entities would let a crafted "&lt;" through
    // as markup, so & in the input is always data. Escape once, at the point
    // of interpolation.
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    expect(escapeHtml(escapeHtml("<b>"))).not.toBe(escapeHtml("<b>"));
  });

  it("renders a realistic XSS payload inert", () => {
    const payload = `<img src=x onerror="alert('xss')">`;
    const escaped = escapeHtml(payload);
    expect(escaped).toBe("&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;");
    expect(escaped).not.toContain("<img");
    expect(escaped).not.toContain('"');
  });
});
