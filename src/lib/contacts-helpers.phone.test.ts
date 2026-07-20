import { describe, it, expect } from "vitest";
import { phoneEntrySchema } from "./contacts-helpers.server";

describe("phoneEntrySchema.number normalization", () => {
  const parse = (number: string) =>
    phoneEntrySchema.safeParse({ label: "mobile", number });

  it("trims edges and preserves extension separators", () => {
    const r = parse("  800-225-1865 ;7160 ");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.number).toBe("800-225-1865 ;7160");
  });

  it("collapses inner whitespace including NBSP and tabs", () => {
    const r = parse("555\u00A0123\t4567");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.number).toBe("555 123 4567");
  });

  it("accepts +, parens, commas and repeated separators", () => {
    const r = parse("+1 (415) 555-0100,,,123");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.number).toBe("+1 (415) 555-0100,,,123");
  });

  it("rejects characters outside the allow-list", () => {
    const r = parse("555-hello😀");
    expect(r.success).toBe(false);
  });
});
