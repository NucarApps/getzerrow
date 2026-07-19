// Auto-apply gate for background group suggestions. Deterministic evidence
// decides; the AI's self-reported confidence can only VETO. Anything that
// fails stays a pending suggestion in the drawer — "if it's not super
// clear, make suggestions".

import { describe, it, expect } from "vitest";
import { evaluateAutoApply } from "./suggestion-confidence";

const baseCtx = () => ({
  companyIdByContact: new Map<string, string | null>([
    ["c1", "nissan"],
    ["c2", "nissan"],
    ["c3", "nissan"],
    ["c4", "toyota"],
  ]),
  domainByContact: new Map<string, string | null>([
    ["c1", "nissan.com"],
    ["c2", "nissan.com"],
    ["c3", "nissanusa.com"],
    ["c4", "toyota.com"],
    ["p1", "gmail.com"],
    ["p2", "gmail.com"],
  ]),
  isPersonalDomain: (d: string) => d === "gmail.com",
  companyIdByDomain: new Map<string, string>([
    ["nissan.com", "nissan"],
    ["nissanusa.com", "nissan"],
    ["toyota.com", "toyota"],
  ]),
  targetLabelCompanyId: "nissan" as string | null,
  suggestionNameCompanyId: null as string | null,
});

const suggestion = (over: Partial<Parameters<typeof evaluateAutoApply>[0]> = {}) => ({
  contact_ids: ["c1", "c2", "c3"],
  confidence: "high" as const,
  ...over,
});

describe("evaluateAutoApply", () => {
  it("auto-applies a company-backed cluster targeting that company's label", () => {
    const res = evaluateAutoApply(suggestion(), baseCtx());
    expect(res.autoApply).toBe(true);
    expect(res.rule).toEqual({ ruleType: "company_id", value: "nissan" });
  });

  it("auto-applies when the suggestion NAME resolves to the dominant company", () => {
    const ctx = { ...baseCtx(), targetLabelCompanyId: null, suggestionNameCompanyId: "nissan" };
    const res = evaluateAutoApply(suggestion(), ctx);
    expect(res.autoApply).toBe(true);
  });

  it("auto-applies a domain-backed cluster mapping to one company", () => {
    const ctx = {
      ...baseCtx(),
      companyIdByContact: new Map<string, string | null>(),
      targetLabelCompanyId: null,
      suggestionNameCompanyId: "nissan",
    };
    const res = evaluateAutoApply(suggestion({ contact_ids: ["c1", "c2"] }), ctx);
    expect(res.autoApply).toBe(true);
    expect(res.rule).toEqual({ ruleType: "domain", value: "nissan.com" });
  });

  it("rejects personal-domain clusters", () => {
    const ctx = {
      ...baseCtx(),
      companyIdByContact: new Map<string, string | null>(),
      targetLabelCompanyId: null,
    };
    const res = evaluateAutoApply(suggestion({ contact_ids: ["p1", "p2"] }), ctx);
    expect(res.autoApply).toBe(false);
  });

  it("rejects mixed-company clusters below the 80% threshold", () => {
    const res = evaluateAutoApply(suggestion({ contact_ids: ["c1", "c2", "c4", "c4"] }), {
      ...baseCtx(),
    });
    expect(res.autoApply).toBe(false);
  });

  it("rejects when the target label belongs to a DIFFERENT company", () => {
    const ctx = { ...baseCtx(), targetLabelCompanyId: "toyota" };
    const res = evaluateAutoApply(suggestion(), ctx);
    expect(res.autoApply).toBe(false);
  });

  it("AI-high with no deterministic evidence fails", () => {
    const ctx = {
      ...baseCtx(),
      companyIdByContact: new Map<string, string | null>(),
      domainByContact: new Map<string, string | null>(),
      targetLabelCompanyId: null,
    };
    expect(evaluateAutoApply(suggestion(), ctx).autoApply).toBe(false);
  });

  it("AI-low with perfect evidence fails (veto works both ways)", () => {
    for (const confidence of ["medium", "low", null] as const) {
      expect(evaluateAutoApply(suggestion({ confidence }), baseCtx()).autoApply).toBe(false);
    }
  });

  it("requires at least two members", () => {
    expect(evaluateAutoApply(suggestion({ contact_ids: ["c1"] }), baseCtx()).autoApply).toBe(false);
  });
});
