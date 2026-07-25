import { describe, expect, it } from "vitest";
import { companyBrandKey } from "./company-name";

describe("companyBrandKey", () => {
  it("normalizes case and whitespace", () => {
    expect(companyBrandKey("Honda")).toBe("honda");
    expect(companyBrandKey("  honda  ")).toBe("honda");
    expect(companyBrandKey("HONDA")).toBe("honda");
    expect(companyBrandKey("Honda  Motor  Co")).toBe("honda");
  });

  it("strips legal suffixes", () => {
    expect(companyBrandKey("Honda Inc.")).toBe("honda");
    expect(companyBrandKey("Honda, LLC")).toBe("honda");
    expect(companyBrandKey("Honda Motor Co Ltd")).toBe("honda");
    expect(companyBrandKey("Acme Corporation")).toBe("acme");
  });

  it("strips corporate qualifiers so brand variants collapse", () => {
    expect(companyBrandKey("Nissan North America")).toBe("nissan");
    expect(companyBrandKey("Nissan-USA")).toBe("nissan");
    expect(companyBrandKey("The Honda Company")).toBe("honda");
    expect(companyBrandKey("American Honda")).toBe("honda");
    expect(companyBrandKey("American Honda Motor Co., Inc.")).toBe("honda");
    // Distinct businesses sharing the brand token stay distinct.
    expect(companyBrandKey("Nissan Of Keene")).toBe("nissan of keene");
    expect(companyBrandKey("Boch Nissan South")).toBe("boch nissan");
  });

  it("documents the tradeoff of stripping leading 'American'", () => {
    // Brands genuinely starting with "American" lose that token — the same
    // accepted risk class as the other leading-qualifier strips ("The",
    // "North"). Collisions require another company keyed to the bare noun,
    // and every merge path built on this key stays user-confirmed.
    expect(companyBrandKey("American Airlines")).toBe("airlines");
    expect(companyBrandKey("American Express")).toBe("express");
  });

  it("returns null for empty or too-short inputs", () => {
    expect(companyBrandKey("")).toBeNull();
    expect(companyBrandKey(null)).toBeNull();
    expect(companyBrandKey(undefined)).toBeNull();
    expect(companyBrandKey("-")).toBeNull();
    expect(companyBrandKey("A")).toBeNull();
  });

  it("keeps single-suffix-only names intact", () => {
    // "Co" alone shouldn't be stripped to empty; keep it.
    expect(companyBrandKey("Co")).toBe("co");
  });
});
