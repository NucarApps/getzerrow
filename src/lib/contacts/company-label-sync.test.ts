import { describe, expect, it } from "vitest";
import { pairKey, planRuleMembershipSync } from "./company-label-sync";
import type { ContactSignals, GroupRule } from "./group-rules";

function rule(overrides: Partial<GroupRule> & Pick<GroupRule, "group_id" | "value">): GroupRule {
  return {
    id: overrides.id ?? `${overrides.group_id}-${overrides.value}`,
    rule_type: overrides.rule_type ?? "company_id",
    auto_apply: overrides.auto_apply ?? true,
    ...overrides,
  } as GroupRule;
}

function signals(overrides: Partial<ContactSignals> = {}): ContactSignals {
  return { companyId: null, aiCategory: null, emailDomains: [], ...overrides };
}

const FACTORY = "g-factory";
const NISSAN = "co-nissan";

describe("planRuleMembershipSync", () => {
  it("adds every company contact for a company-in-label rule", () => {
    const plan = planRuleMembershipSync({
      rules: [rule({ group_id: FACTORY, value: NISSAN })],
      signalsByContact: new Map([
        ["c1", signals({ companyId: NISSAN })],
        ["c2", signals({ companyId: NISSAN })],
        ["c3", signals({ companyId: "co-other" })],
      ]),
      currentRuleRows: [],
      existingMemberPairs: new Set(),
    });
    expect(plan.toAdd.map((p) => p.contact_id).sort()).toEqual(["c1", "c2"]);
    expect(plan.toRemove).toEqual([]);
  });

  it("skips contacts already members via any source (never demotes)", () => {
    const plan = planRuleMembershipSync({
      rules: [rule({ group_id: FACTORY, value: NISSAN })],
      signalsByContact: new Map([["c1", signals({ companyId: NISSAN })]]),
      currentRuleRows: [],
      existingMemberPairs: new Set([pairKey(FACTORY, "c1")]), // manual row
    });
    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual([]);
  });

  it("removes a rule row when the contact left the company", () => {
    const plan = planRuleMembershipSync({
      rules: [rule({ group_id: FACTORY, value: NISSAN })],
      signalsByContact: new Map([["c1", signals({ companyId: "co-elsewhere" })]]),
      currentRuleRows: [{ group_id: FACTORY, contact_id: "c1" }],
      existingMemberPairs: new Set([pairKey(FACTORY, "c1")]),
    });
    expect(plan.toRemove).toEqual([{ group_id: FACTORY, contact_id: "c1" }]);
    expect(plan.toAdd).toEqual([]);
  });

  it("removes rule rows when the rule itself is gone", () => {
    const plan = planRuleMembershipSync({
      rules: [], // company rule deleted
      signalsByContact: new Map([["c1", signals({ companyId: NISSAN })]]),
      currentRuleRows: [{ group_id: FACTORY, contact_id: "c1" }],
      existingMemberPairs: new Set([pairKey(FACTORY, "c1")]),
    });
    expect(plan.toRemove).toEqual([{ group_id: FACTORY, contact_id: "c1" }]);
  });

  it("keeps a rule row still justified by a different rule type", () => {
    const plan = planRuleMembershipSync({
      rules: [rule({ group_id: FACTORY, value: "nissan-usa.com", rule_type: "domain" })],
      signalsByContact: new Map([
        ["c1", signals({ companyId: "co-elsewhere", emailDomains: ["nissan-usa.com"] })],
      ]),
      currentRuleRows: [{ group_id: FACTORY, contact_id: "c1" }],
      existingMemberPairs: new Set([pairKey(FACTORY, "c1")]),
    });
    expect(plan.toRemove).toEqual([]);
    expect(plan.toAdd).toEqual([]); // already a member
  });

  it("ignores non-auto rules for both add and keep", () => {
    const plan = planRuleMembershipSync({
      rules: [rule({ group_id: FACTORY, value: NISSAN, auto_apply: false })],
      signalsByContact: new Map([["c1", signals({ companyId: NISSAN })]]),
      currentRuleRows: [{ group_id: FACTORY, contact_id: "c1" }],
      existingMemberPairs: new Set([pairKey(FACTORY, "c1")]),
    });
    expect(plan.toAdd).toEqual([]);
    expect(plan.toRemove).toEqual([{ group_id: FACTORY, contact_id: "c1" }]);
  });

  it("never removes rows for contacts outside the loaded scope", () => {
    const plan = planRuleMembershipSync({
      rules: [],
      signalsByContact: new Map(), // nothing in scope
      currentRuleRows: [{ group_id: FACTORY, contact_id: "c-out-of-scope" }],
      existingMemberPairs: new Set(),
    });
    expect(plan.toRemove).toEqual([]);
  });
});
