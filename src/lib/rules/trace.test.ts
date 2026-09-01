import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate";
import {
  decidingStage,
  isLegacyTrace,
  parseRulesTrace,
  STAGE_ORDER,
  stageRows,
  traceHeadline,
} from "./trace";
import type { EngineMessage, EvaluateContext, Rule } from "./types";

const message = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  from_addr: "billing@netflix.com",
  from_name: "Netflix",
  to_addrs: "me@example.com",
  subject: "Your receipt",
  body_text: "thanks",
  has_attachment: false,
  ...over,
});

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: "11111111-1111-1111-1111-111111111111",
  folder_id: "f1",
  created_at: "2026-01-01T00:00:00.000Z",
  groups: [[{ field: "from", op: "contains", value: "billing@netflix.com" }]],
  ...over,
});

const context = (over: Partial<EvaluateContext> = {}): EvaluateContext => ({
  folders: [{ id: "f1", name: "Receipts" }],
  rules: [rule()],
  pins: [],
  guardrails: [],
  ...over,
});

describe("parseRulesTrace", () => {
  it("round-trips a trace produced by evaluate", () => {
    const result = evaluate(message(), context(), { trigger: "arrival", aiEnabled: false });
    const parsed = parseRulesTrace(JSON.parse(JSON.stringify(result.trace)));
    expect(parsed).toEqual(result.trace);
  });

  it("returns null for empty, malformed, and v1 values", () => {
    expect(parseRulesTrace(null)).toBeNull();
    expect(parseRulesTrace("nope")).toBeNull();
    expect(parseRulesTrace({ version: 1, steps: [] })).toBeNull();
    expect(parseRulesTrace({ version: 2, stages: "broken" })?.stages).toEqual([]);
  });

  it("flags v1 traces as legacy", () => {
    expect(isLegacyTrace({ version: 1, steps: [] })).toBe(true);
    expect(isLegacyTrace({ version: 2 })).toBe(false);
  });

  it("drops junk stages, rules and conditions instead of throwing", () => {
    const parsed = parseRulesTrace({
      version: 2,
      trigger: "not_a_trigger",
      stages: [{ stage: "rule", outcome: "applied" }, { stage: "nope", outcome: "applied" }, 7],
      matched_rules: [{ rule_id: "r1", folder_id: "f1", level: 9 }, null],
      failed_rules: [
        {
          rule_id: "r2",
          folder_id: "f1",
          level: 5,
          conditions: [{ field: "subject", op: "contains", value: "x", passed: false }, "junk"],
        },
      ],
      vetoed_folder_ids: ["f2", 4],
      winner: { rule_id: "r1", folder_id: "f1", level: 2, reason: "older rule" },
      collision: { level: 2, winner_rule_id: "r1", loser_rule_ids: ["r3"], folder_ids: ["f1"] },
      ai: { eligible_folder_ids: ["f1"], enabled: true },
    });
    expect(parsed?.trigger).toBe("arrival");
    expect(parsed?.stages).toHaveLength(1);
    expect(parsed?.matched_rules).toHaveLength(0);
    expect(parsed?.failed_rules[0]?.conditions).toHaveLength(1);
    expect(parsed?.vetoed_folder_ids).toEqual(["f2"]);
    expect(parsed?.winner?.level).toBe(2);
    expect(parsed?.collision?.reason).toBe("");
    expect(parsed?.ai?.enabled).toBe(true);
  });
});

describe("trace presentation", () => {
  it("names the rules stage winner with its ladder level", () => {
    const result = evaluate(message(), context(), { trigger: "arrival", aiEnabled: false });
    expect(decidingStage(result.trace)?.stage).toBe("rule");
    expect(traceHeadline(result.trace)).toBe("L1 exact sender rule decided this on arrival");
  });

  it("names a non-rule stage when that stage decided", () => {
    const result = evaluate(
      message(),
      context({
        pins: [{ id: "p1", kind: "inbox", match: "email", value: "billing@netflix.com" }],
      }),
      { trigger: "arrival", aiEnabled: false },
    );
    expect(traceHeadline(result.trace)).toBe("Your pins decided this on arrival");
  });

  it("renders every ladder stage, marking the ones never reached", () => {
    const result = evaluate(message(), context(), { trigger: "arrival", aiEnabled: false });
    const rows = stageRows(result.trace);
    expect(rows.map((r) => r.stage)).toEqual([...STAGE_ORDER]);
    expect(rows.find((r) => r.stage === "inbox")?.outcome).toBe("not_reached");
    expect(rows.find((r) => r.stage === "rule")?.outcome).toBe("applied");
  });
});
