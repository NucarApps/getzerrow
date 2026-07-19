import { describe, expect, it } from "vitest";
import {
  collectEmailDomains,
  domainOfEmail,
  isAiCategory,
  matchRules,
  type GroupRule,
} from "./group-rules";

describe("domainOfEmail", () => {
  it("returns lowercase domain", () => {
    expect(domainOfEmail("Foo@Nissan.com")).toBe("nissan.com");
  });
  it("handles null and malformed", () => {
    expect(domainOfEmail(null)).toBeNull();
    expect(domainOfEmail("no-at")).toBeNull();
    expect(domainOfEmail("a@")).toBeNull();
  });
});

describe("collectEmailDomains", () => {
  it("dedupes across emails", () => {
    expect(
      collectEmailDomains([
        { address: "a@nissan.com" },
        { address: "b@NISSAN.com" },
        { address: "c@ford.com" },
      ]),
    ).toEqual(["nissan.com", "ford.com"]);
  });
});

describe("matchRules", () => {
  const rules: GroupRule[] = [
    { id: "r1", group_id: "g1", rule_type: "domain", value: "nissan.com", auto_apply: true },
    { id: "r2", group_id: "g2", rule_type: "ai_category", value: "software", auto_apply: false },
    { id: "r3", group_id: "g3", rule_type: "company_id", value: "co-abc", auto_apply: true },
  ];

  it("matches by email domain", () => {
    const m = matchRules(
      { companyId: null, aiCategory: null, emailDomains: ["nissan.com"] },
      rules,
    );
    expect(m.map((x) => x.groupId)).toEqual(["g1"]);
    expect(m[0].autoApply).toBe(true);
  });

  it("matches by ai_category and preserves suggest-only", () => {
    const m = matchRules({ companyId: null, aiCategory: "Software", emailDomains: [] }, rules);
    expect(m.map((x) => x.groupId)).toEqual(["g2"]);
    expect(m[0].autoApply).toBe(false);
  });

  it("matches by company_id", () => {
    const m = matchRules({ companyId: "co-abc", aiCategory: null, emailDomains: [] }, rules);
    expect(m.map((x) => x.groupId)).toEqual(["g3"]);
  });

  it("returns multiple matches when signals overlap", () => {
    const m = matchRules(
      { companyId: "co-abc", aiCategory: "software", emailDomains: ["nissan.com"] },
      rules,
    );
    expect(m.map((x) => x.groupId).sort()).toEqual(["g1", "g2", "g3"]);
  });

  it("ignores empty values", () => {
    const m = matchRules({ companyId: null, aiCategory: "software", emailDomains: [] }, [
      { id: "r", group_id: "g", rule_type: "ai_category", value: "  ", auto_apply: true },
    ]);
    expect(m).toEqual([]);
  });
});

describe("AI_CATEGORIES", () => {
  it("guards known slugs", () => {
    expect(isAiCategory("software")).toBe(true);
    expect(isAiCategory("bogus")).toBe(false);
  });
});
