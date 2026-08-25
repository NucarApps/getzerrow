import { describe, expect, it } from "vitest";
import { resolveRules } from "./resolve";
import type { EngineFolder, EngineMessage, Rule } from "./types";

const folders: EngineFolder[] = [
  { id: "receipts", name: "Receipts" },
  { id: "shipping", name: "Shipping" },
  { id: "paused", name: "Paused", processing_enabled: false },
];

const msg = (over: Partial<EngineMessage> = {}): EngineMessage => ({
  from_addr: "billing@amazon.com",
  from_name: "Amazon Billing",
  to_addrs: "me@example.com",
  subject: "Your order receipt",
  body_text: "thanks",
  has_attachment: false,
  ...over,
});

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "folder_id" | "groups">): Rule => ({
  created_at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("resolveRules — specificity ladder", () => {
  it("L1 exact sender beats L3 domain family", () => {
    const res = resolveRules(
      msg(),
      [
        rule({
          id: "domain",
          folder_id: "shipping",
          groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
        }),
        rule({
          id: "sender",
          folder_id: "receipts",
          groups: [[{ field: "from", op: "contains", value: "billing@amazon.com" }]],
        }),
      ],
      folders,
    );
    expect(res.winner?.rule.id).toBe("sender");
    expect(res.winner?.level).toBe(1);
    expect(res.collision).toBeNull();
  });

  it("L2 exact domain beats L3 domain family", () => {
    const res = resolveRules(
      msg(),
      [
        rule({
          id: "family",
          folder_id: "shipping",
          groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
        }),
        rule({
          id: "exact",
          folder_id: "receipts",
          groups: [[{ field: "domain", op: "equals", value: "amazon.com" }]],
        }),
      ],
      folders,
    );
    expect(res.winner?.rule.id).toBe("exact");
  });

  it("within a level, more conditions wins", () => {
    const res = resolveRules(
      msg(),
      [
        rule({
          id: "one",
          folder_id: "shipping",
          groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
        }),
        rule({
          id: "two",
          folder_id: "receipts",
          groups: [
            [
              { field: "domain", op: "contains", value: "amazon.com" },
              { field: "subject", op: "contains", value: "receipt" },
            ],
          ],
        }),
      ],
      folders,
    );
    expect(res.winner?.rule.id).toBe("two");
    expect(res.winner?.reason).toContain("more conditions");
  });

  it("final tiebreak is the older rule, and reports a collision", () => {
    const res = resolveRules(
      msg(),
      [
        rule({
          id: "newer",
          folder_id: "shipping",
          created_at: "2026-05-01T00:00:00.000Z",
          groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
        }),
        rule({
          id: "older",
          folder_id: "receipts",
          created_at: "2026-02-01T00:00:00.000Z",
          groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
        }),
      ],
      folders,
    );
    expect(res.winner?.rule.id).toBe("older");
    expect(res.collision).toMatchObject({
      level: 3,
      winner_rule_id: "older",
      loser_rule_ids: ["newer"],
    });
  });

  it("does not report a collision when same-level rules share a folder", () => {
    const res = resolveRules(
      msg(),
      [
        rule({
          id: "a",
          folder_id: "receipts",
          groups: [[{ field: "domain", op: "contains", value: "amazon.com" }]],
        }),
        rule({
          id: "b",
          folder_id: "receipts",
          created_at: "2026-06-01T00:00:00.000Z",
          groups: [[{ field: "domain", op: "contains", value: "amazon" }]],
        }),
      ],
      folders,
    );
    expect(res.collision).toBeNull();
    expect(res.winner?.rule.id).toBe("a");
  });

  it("ordering of the input array never changes the outcome", () => {
    const rules = [
      rule({
        id: "content",
        folder_id: "shipping",
        groups: [[{ field: "subject", op: "contains", value: "receipt" }]],
      }),
      rule({
        id: "sender",
        folder_id: "receipts",
        groups: [[{ field: "from", op: "contains", value: "billing@amazon.com" }]],
      }),
    ];
    const a = resolveRules(msg(), rules, folders).winner?.rule.id;
    const b = resolveRules(msg(), [...rules].reverse(), folders).winner?.rule.id;
    expect(a).toBe("sender");
    expect(b).toBe("sender");
  });

  it("skips rules of paused and vetoed folders", () => {
    const rules = [
      rule({
        id: "paused",
        folder_id: "paused",
        groups: [[{ field: "from", op: "contains", value: "billing@amazon.com" }]],
      }),
      rule({
        id: "vetoed",
        folder_id: "shipping",
        groups: [[{ field: "from", op: "contains", value: "billing@amazon.com" }]],
      }),
      rule({
        id: "ok",
        folder_id: "receipts",
        groups: [[{ field: "subject", op: "contains", value: "receipt" }]],
      }),
    ];
    const res = resolveRules(msg(), rules, folders, { vetoedFolderIds: ["shipping"] });
    expect(res.winner?.rule.id).toBe("ok");
    expect(res.matched.map((m) => m.rule_id)).toEqual(["ok"]);
  });

  it("traces failed rules with per-condition pass/fail, capped at 10", () => {
    const rules = Array.from({ length: 14 }, (_, i) =>
      rule({
        id: `miss${i}`,
        folder_id: "receipts",
        groups: [
          [
            { field: "domain", op: "contains", value: "amazon.com" },
            { field: "subject", op: "contains", value: "nope" },
          ],
        ],
      }),
    );
    const res = resolveRules(msg(), rules, folders);
    expect(res.winner).toBeNull();
    expect(res.failed).toHaveLength(10);
    expect(res.failed[0]!.conditions).toEqual([
      { field: "domain", op: "contains", value: "amazon.com", passed: true },
      { field: "subject", op: "contains", value: "nope", passed: false },
    ]);
  });

  it("matches an OR group when either side holds", () => {
    const res = resolveRules(
      msg({ subject: "shipped" }),
      [
        rule({
          id: "or",
          folder_id: "shipping",
          groups: [
            [{ field: "subject", op: "contains", value: "receipt" }],
            [{ field: "subject", op: "contains", value: "shipped" }],
          ],
        }),
      ],
      folders,
    );
    expect(res.winner?.rule.id).toBe("or");
  });

  it("ignores disabled rules", () => {
    const res = resolveRules(
      msg(),
      [
        rule({
          id: "off",
          folder_id: "receipts",
          enabled: false,
          groups: [[{ field: "from", op: "contains", value: "billing@amazon.com" }]],
        }),
      ],
      folders,
    );
    expect(res.winner).toBeNull();
  });
});
