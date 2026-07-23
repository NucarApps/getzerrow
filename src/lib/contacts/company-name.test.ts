import { describe, expect, it } from "vitest";
import { normalizeCompanyName } from "./company-name";

describe("normalizeCompanyName", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeCompanyName("Honda")).toBe("honda");
    expect(normalizeCompanyName("  honda  ")).toBe("honda");
    expect(normalizeCompanyName("HONDA")).toBe("honda");
    expect(normalizeCompanyName("Honda  Motor  Co")).toBe("honda");
  });

  it("strips legal suffixes", () => {
    expect(normalizeCompanyName("Honda Inc.")).toBe("honda");
    expect(normalizeCompanyName("Honda, LLC")).toBe("honda");
    expect(normalizeCompanyName("Honda Motor Co Ltd")).toBe("honda");
    expect(normalizeCompanyName("Acme Corporation")).toBe("acme");
  });

  it("strips corporate qualifiers so brand variants collapse", () => {
    expect(normalizeCompanyName("Nissan North America")).toBe("nissan");
    expect(normalizeCompanyName("Nissan-USA")).toBe("nissan");
    expect(normalizeCompanyName("The Honda Company")).toBe("honda");
    expect(normalizeCompanyName("American Honda")).toBe("honda");
    expect(normalizeCompanyName("American Honda Motor Co., Inc.")).toBe("honda");
    // Distinct businesses sharing the brand token stay distinct.
    expect(normalizeCompanyName("Nissan Of Keene")).toBe("nissan of keene");
    expect(normalizeCompanyName("Boch Nissan South")).toBe("boch nissan");
  });

  it("documents the tradeoff of stripping leading 'American'", () => {
    // Brands genuinely starting with "American" lose that token — the same
    // accepted risk class as the other leading-qualifier strips ("The",
    // "North"). Collisions require another company keyed to the bare noun,
    // and every merge path built on this key stays user-confirmed.
    expect(normalizeCompanyName("American Airlines")).toBe("airlines");
    expect(normalizeCompanyName("American Express")).toBe("express");
  });

  it("returns null for empty or too-short inputs", () => {
    expect(normalizeCompanyName("")).toBeNull();
    expect(normalizeCompanyName(null)).toBeNull();
    expect(normalizeCompanyName(undefined)).toBeNull();
    expect(normalizeCompanyName("-")).toBeNull();
    expect(normalizeCompanyName("A")).toBeNull();
  });

  it("keeps single-suffix-only names intact", () => {
    // "Co" alone shouldn't be stripped to empty; keep it.
    expect(normalizeCompanyName("Co")).toBe("co");
  });
});
