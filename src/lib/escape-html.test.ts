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

  it("does not touch single quotes (pinning current behavior, not a guarantee of safety)", () => {
    // Only & < > " are escaped. A single quote passes through untouched, so
    // this helper is only safe inside a double-quoted attribute, not a
    // single-quoted one.
    expect(escapeHtml("it's")).toBe("it's");
  });

  it("escapes & first so an already-escaped entity like &amp; becomes double-escaped", () => {
    // The replace chain runs & before < > ", so a literal "&amp;" in the
    // input has its own & escaped too — this is NOT idempotent.
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    expect(escapeHtml(escapeHtml("<b>"))).not.toBe(escapeHtml("<b>"));
  });

  it("renders a realistic XSS payload inert", () => {
    const payload = `<img src=x onerror="alert('xss')">`;
    const escaped = escapeHtml(payload);
    expect(escaped).toBe("&lt;img src=x onerror=&quot;alert('xss')&quot;&gt;");
    expect(escaped).not.toContain("<img");
    expect(escaped).not.toContain('"');
  });
});
