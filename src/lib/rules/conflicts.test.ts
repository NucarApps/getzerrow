import { describe, expect, it } from "vitest";
import { checkRuleConflicts, type SampleMessage } from "./conflicts";
import type { EngineFolder, Rule } from "./types";

const folders: EngineFolder[] = [
  { id: "receipts", name: "Receipts" },
  { id: "finance", name: "Finance" },
  { id: "paused", name: "Paused", processing_enabled: false },
];

const msg = (over: Partial<SampleMessage> & { id: string }): SampleMessage => ({
  from_addr: "billing@netflix.com",
  from_name: "Netflix",
  to_addrs: "me@example.com",
  subject: "Your receipt",
  body_text: "",
  has_attachment: false,
  received_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

const rule = (over: Partial<Rule> & { id: string; folder_id: string }): Rule => ({
  created_at: "2026-01-01T00:00:00.000Z",
  groups: [[{ field: "from", op: "contains", value: "billing@netflix.com" }]],
  ...over,
});

const sample = [msg({ id: "e1" }), msg({ id: "e2", subject: "Receipt 2" })];

describe("checkRuleConflicts", () => {
  it("counts the candidate's own matches and returns samples", () => {
    const report = checkRuleConflicts(rule({ id: "new", folder_id: "receipts" }), [], folders, [
      ...sample,
      msg({ id: "e3", from_addr: "someone@else.com", from_name: "Else" }),
    ]);
    expect(report.candidate_match_count).toBe(2);
    expect(report.candidate_samples.map((s) => s.id)).toEqual(["e1", "e2"]);
    expect(report.candidate_level).toBe(1);
    expect(report.blocked).toBe(false);
  });

  it("proposes a merge for a same-level rule on the same folder", () => {
    const report = checkRuleConflicts(
      rule({ id: "new", folder_id: "receipts" }),
      [rule({ id: "old", folder_id: "receipts" })],
      folders,
      sample,
    );
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]!.kind).toBe("merge");
    expect(report.blocked).toBe(false);
    expect(report.conflicts[0]!.message).toContain("fold this into that rule");
  });

  it("blocks a same-level rule that claims the same mail for another folder", () => {
    const report = checkRuleConflicts(
      rule({ id: "new", folder_id: "receipts" }),
      [rule({ id: "old", folder_id: "finance" })],
      folders,
      sample,
    );
    expect(report.blocked).toBe(true);
    expect(report.conflicts[0]!.kind).toBe("block");
    expect(report.conflicts[0]!.folder_name).toBe("Finance");
    expect(report.conflicts[0]!.overlap_count).toBe(2);
  });

  it("treats a cross-level overlap as informational and names the ladder winner", () => {
    const report = checkRuleConflicts(
      rule({ id: "new", folder_id: "receipts" }),
      [
        rule({
          id: "old",
          folder_id: "finance",
          groups: [[{ field: "subject", op: "contains", value: "receipt" }]],
        }),
      ],
      folders,
      sample,
    );
    expect(report.blocked).toBe(false);
    expect(report.conflicts[0]!.kind).toBe("info");
    expect(report.conflicts[0]!.winner).toBe("candidate");
    expect(report.conflicts[0]!.message).toContain("L1 exact sender");
  });

  it("ignores the rule being edited, disabled rules and paused folders", () => {
    const existing = [
      rule({ id: "same", folder_id: "finance" }),
      rule({ id: "off", folder_id: "finance", enabled: false }),
      rule({ id: "paused", folder_id: "paused" }),
      rule({ id: "excluded", folder_id: "finance" }),
    ];
    const report = checkRuleConflicts(
      rule({ id: "same", folder_id: "receipts" }),
      existing,
      folders,
      sample,
      { ignoreRuleIds: ["excluded"] },
    );
    expect(report.conflicts).toHaveLength(0);
  });

  it("orders blocks before merges before info", () => {
    const report = checkRuleConflicts(
      rule({ id: "new", folder_id: "receipts" }),
      [
        rule({
          id: "info",
          folder_id: "finance",
          groups: [[{ field: "subject", op: "contains", value: "receipt" }]],
        }),
        rule({ id: "merge", folder_id: "receipts" }),
        rule({ id: "block", folder_id: "finance" }),
      ],
      folders,
      sample,
    );
    expect(report.conflicts.map((c) => c.kind)).toEqual(["block", "merge", "info"]);
  });
});
