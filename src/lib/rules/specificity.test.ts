import { describe, expect, it } from "vitest";
import { conditionLevel, deriveRuleLevel, ruleConditionCount, levelLabel } from "./specificity";
import type { Rule } from "./types";

const rule = (groups: Rule["groups"]): Rule => ({
  id: "r",
  folder_id: "f",
  created_at: "2026-01-01T00:00:00.000Z",
  groups,
});

describe("conditionLevel", () => {
  const cases: Array<[string, { field: string; op: string; value: string }, number]> = [
    ["exact sender", { field: "from", op: "equals", value: "billing@netflix.com" }, 1],
    ["sender contains address", { field: "from", op: "contains", value: "billing@netflix.com" }, 1],
    ["origin sender", { field: "origin_from", op: "contains", value: "a@b.com" }, 1],
    ["sender field with @domain", { field: "from", op: "equals", value: "@amazon.com" }, 2],
    ["sender field with bare domain", { field: "from", op: "contains", value: "amazon.com" }, 3],
    ["exact domain", { field: "domain", op: "equals", value: "amazon.com" }, 2],
    ["domain allowlist", { field: "domain", op: "domain_in", value: "amazon.com" }, 2],
    ["domain family", { field: "domain", op: "contains", value: "amazon.com" }, 3],
    ["origin domain family", { field: "origin_domain", op: "contains", value: "amazon.com" }, 3],
    ["list id", { field: "list_id", op: "contains", value: "x" }, 4],
    ["to", { field: "to", op: "equals", value: "me@x.com" }, 4],
    ["attachment", { field: "has_attachment", op: "equals", value: "true" }, 4],
    ["sender group", { field: "sender_in_group", op: "equals", value: "g1" }, 4],
    ["subject", { field: "subject", op: "contains", value: "invoice" }, 5],
    ["body", { field: "body", op: "regex", value: "receipt" }, 5],
  ];

  for (const [name, condition, level] of cases) {
    it(`${name} is L${level}`, () => {
      expect(conditionLevel(condition)).toBe(level);
    });
  }
});

describe("deriveRuleLevel", () => {
  it("uses the most specific condition", () => {
    expect(
      deriveRuleLevel(
        rule([
          [
            { field: "subject", op: "contains", value: "invoice" },
            { field: "from", op: "equals", value: "billing@netflix.com" },
          ],
        ]),
      ),
    ).toBe(1);
  });

  it("looks across OR groups", () => {
    expect(
      deriveRuleLevel(
        rule([
          [{ field: "subject", op: "contains", value: "x" }],
          [{ field: "domain", op: "equals", value: "amazon.com" }],
        ]),
      ),
    ).toBe(2);
  });

  it("defaults an empty rule to the least specific level", () => {
    expect(deriveRuleLevel(rule([]))).toBe(5);
  });
});

describe("helpers", () => {
  it("counts conditions across groups", () => {
    expect(
      ruleConditionCount(
        rule([
          [
            { field: "domain", op: "contains", value: "a.com" },
            { field: "subject", op: "contains", value: "b" },
          ],
          [{ field: "to", op: "equals", value: "c@d.com" }],
        ]),
      ),
    ).toBe(3);
  });

  it("labels levels for the editor badge", () => {
    expect(levelLabel(2)).toBe("L2 exact domain");
  });
});
