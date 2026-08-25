import { describe, expect, it } from "vitest";
import { classifiedByForStage, compareDecisions, isRuleLabel } from "./compare";
import type { EvaluateResult, RulesTrace, Stage } from "./types";
import { RULES_TRACE_VERSION } from "./types";

const engineResult = (over: Partial<EvaluateResult> = {}): EvaluateResult => {
  const trace: RulesTrace = {
    version: RULES_TRACE_VERSION,
    trigger: "arrival",
    stages: [],
    matched_rules: [],
    failed_rules: [],
    vetoed_folder_ids: [],
  };
  return {
    folder_id: "f1",
    stage: "rule",
    needs_ai: false,
    ai_candidate_folder_ids: [],
    reason: "matched",
    trace,
    ...over,
  };
};

describe("compareDecisions", () => {
  it("agrees when both engines reach the same folder", () => {
    const v = compareDecisions(
      { folder_id: "f1", classified_by: "filter", needs_ai: false },
      engineResult(),
    );
    expect(v.agree).toBe(true);
    expect(v.detail).toBe("same destination");
  });

  it("marks a shared AI deferral as agreement, not a decision", () => {
    const v = compareDecisions(
      { folder_id: null, classified_by: "none", needs_ai: true },
      engineResult({ folder_id: null, stage: "ai", needs_ai: true }),
    );
    expect(v.agree).toBe(true);
    expect(v.both_defer_to_ai).toBe(true);
    expect(v.detail).toBe("both defer to AI");
  });

  it("describes each shape of disagreement without leaking content", () => {
    const filesMore = compareDecisions(
      { folder_id: null, classified_by: "none", needs_ai: false },
      engineResult(),
    );
    expect(filesMore.detail).toBe("engine files where legacy kept inbox (stage rule)");

    const keepsInbox = compareDecisions(
      { folder_id: "f1", classified_by: "gmail_label", needs_ai: false },
      engineResult({ folder_id: null, stage: "guardrail" }),
    );
    expect(keepsInbox.detail).toBe("engine keeps inbox where legacy filed by gmail_label");

    const defers = compareDecisions(
      { folder_id: "f1", classified_by: "filter", needs_ai: false },
      engineResult({ folder_id: null, stage: "ai", needs_ai: true }),
    );
    expect(defers.detail).toBe("engine defers to AI where legacy filed by filter");

    const other = compareDecisions(
      { folder_id: "f2", classified_by: "filter", needs_ai: false },
      engineResult(),
    );
    expect(other.detail).toBe("different folder: legacy by filter, engine by rule");
    expect(JSON.stringify(other)).not.toContain("subject");
  });
});

describe("classifiedByForStage", () => {
  it("maps every stage onto the existing classifier vocabulary", () => {
    const pairs: Array<[Stage, string]> = [
      ["guardrail", "excluded"],
      ["pin", "global_exclude"],
      ["gmail_label", "gmail_label"],
      ["thread_continuity", "thread_continuity"],
      ["rule", "filter"],
      ["ai", "ai"],
      ["inbox", "none"],
    ];
    for (const [stage, label] of pairs) expect(classifiedByForStage(stage)).toBe(label);
  });

  it("knows which legacy labels mean a deterministic rule fired", () => {
    expect(isRuleLabel("filter")).toBe(true);
    expect(isRuleLabel("domain_rule")).toBe(true);
    expect(isRuleLabel("ai")).toBe(false);
  });
});
