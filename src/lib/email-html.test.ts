// Characterization tests for hasVisibleHtml — used to decide whether an
// email's HTML body has any user-visible text once <style>/<script> blocks,
// remaining tags, and whitespace/&nbsp; entities are stripped, so callers
// know whether to render the HTML body or fall back to plain text.
//
// NOTE: this module does plain regex-based stripping only — it does not
// import DOMPurify and needs no DOM/window, so it runs as-is under the
// node test environment. The DOMPurify sanitization used to actually render
// email HTML lives in src/components/emails/email-body-frame.tsx (a React
// component), not in this src/lib module — see the report for details on
// why that sanitizer isn't covered here.

import { describe, it, expect } from "vitest";
import { hasVisibleHtml } from "./email-html";

describe("hasVisibleHtml", () => {
  it("is false for null and undefined", () => {
    expect(hasVisibleHtml(null)).toBe(false);
    expect(hasVisibleHtml(undefined)).toBe(false);
  });

  it("is false for the empty string", () => {
    expect(hasVisibleHtml("")).toBe(false);
  });

  it("is false for markup with no visible text (tags + whitespace only)", () => {
    expect(hasVisibleHtml("<div>  \n\t  <br/></div>")).toBe(false);
  });

  it("is false when the only content is inside <style> and <script> blocks", () => {
    const html = `<style>.a{color:red}</style><script>alert(1)</script>`;
    expect(hasVisibleHtml(html)).toBe(false);
  });

  it("is false when the only content is &nbsp; and whitespace entities", () => {
    expect(hasVisibleHtml("<p>&nbsp;&nbsp;</p>")).toBe(false);
  });

  it("is true when real text remains after tags are stripped", () => {
    expect(hasVisibleHtml("<p>Hello <b>world</b></p>")).toBe(true);
  });

  it("is true for text mixed with a <style> block containing only CSS", () => {
    const html = `<style>body{margin:0}</style><p>Visible</p>`;
    expect(hasVisibleHtml(html)).toBe(true);
  });

  it("does not strip text sitting outside style/script tags that merely mention 'style' or 'script' as words", () => {
    expect(hasVisibleHtml("<p>My favorite style is minimalist</p>")).toBe(true);
  });
});
