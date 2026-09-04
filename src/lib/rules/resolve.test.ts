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

// Thread scope is a per-folder opt-in (folders.run_on_threads), and the
// legacy engine gates on it (filter-engine.ts matchByFiltersExplained).
// The resolver used to hand threadMessages to EVERY rule, so a folder
// nobody opted in could match on a message that is not the one being
// routed — and the routed message would then be filed on the strength of
// its neighbour's subject.
describe("resolveRules — thread scope is opt-in", () => {
  const threadFolders: EngineFolder[] = [
    { id: "scoped", name: "Message scoped" },
    { id: "threaded", name: "Thread scoped", run_on_threads: true },
  ];
  const incoming = msg({ subject: "Re: following up", from_addr: "someone@partner.test" });
  const prior = [msg({ subject: "The contract draft", from_addr: "someone@partner.test" })];
  const contractRule = (folder_id: string) =>
    rule({
      id: `r-${folder_id}`,
      folder_id,
      groups: [[{ field: "subject", op: "contains", value: "contract" }]],
    });

  it("a folder that opted in matches on a prior message of the thread", () => {
    const res = resolveRules(incoming, [contractRule("threaded")], threadFolders, {
      threadMessages: prior,
    });
    expect(res.winner?.rule.folder_id).toBe("threaded");
  });

  it("a folder that did NOT opt in stays message-scoped", () => {
    const res = resolveRules(incoming, [contractRule("scoped")], threadFolders, {
      threadMessages: prior,
    });
    expect(res.winner).toBeNull();
    expect(res.matched).toEqual([]);
  });

  it("the opted-in folder still needs its own rule to match the incoming message when no thread is supplied", () => {
    const res = resolveRules(incoming, [contractRule("threaded")], threadFolders);
    expect(res.winner).toBeNull();
  });
});

// The ladder's last two rungs, specified rather than merely exercised.
//
// `compareRules` runs level → condition count → age → id. The first rung
// has its own tests above; the rest were only ever reached indirectly, so
// nothing said what SHOULD happen when two rules tie. That matters most
// for `created_at`: `adapt` stamps a filter_tree rule with EPOCH because a
// tree is a JSON column with no authoring timestamp of its own, which
// makes it the oldest thing in the set and the winner of every same-level
// tie. Phase D gives tree rules a real `created_at` in the `rules` table —
// at which point the folder that wins these ties changes, and this is what
// should notice.
describe("compareRules — the tiebreaks below specificity", () => {
  const at = (created_at: string, id: string, folder_id: string, conditions = 1): Rule =>
    rule({
      id,
      folder_id,
      created_at,
      groups: [
        Array.from({ length: conditions }, (_, i) => ({
          field: "subject",
          op: "contains",
          value: i === 0 ? "receipt" : `extra-${i}`,
        })),
      ],
    });

  /** Which folder wins, given rules that all match the same message. */
  const winner = (rules: Rule[]) =>
    resolveRules(msg({ subject: "receipt extra-1 extra-2" }), rules, folders).winner?.rule
      .folder_id;

  it("prefers the rule with MORE conditions at the same level", () => {
    // More conditions is a narrower rule, so it is the more specific
    // author intent even though both sit on the same rung.
    expect(
      winner([
        at("2020-01-01T00:00:00.000Z", "a", "receipts", 1),
        at("2026-01-01T00:00:00.000Z", "b", "shipping", 3),
      ]),
    ).toBe("shipping");
  });

  it("prefers the older rule when level and condition count both tie", () => {
    // Age is the tiebreak because the rule that has been filing this mail
    // longest is the one the user is used to.
    expect(
      winner([
        at("2026-06-01T00:00:00.000Z", "newer", "shipping"),
        at("2020-01-01T00:00:00.000Z", "older", "receipts"),
      ]),
    ).toBe("receipts");
  });

  it("is stable on a same-timestamp tie, ordering by id", () => {
    // Without this the winner would depend on array order, and two
    // identical runs could file the same message differently.
    const same = "2026-01-01T00:00:00.000Z";
    const a = at(same, "aaa", "receipts");
    const b = at(same, "bbb", "shipping");
    expect(winner([a, b])).toBe("receipts");
    expect(winner([b, a])).toBe("receipts");
  });

  it("treats a missing created_at as beatable, not as the oldest", () => {
    // Date.parse("") is NaN, so a comparison against it is never negative
    // — an undated rule must not silently outrank a dated one.
    const undated = rule({
      id: "undated",
      folder_id: "shipping",
      created_at: "",
      groups: [[{ field: "subject", op: "contains", value: "receipt" }]],
    });
    expect(winner([undated, at("2026-01-01T00:00:00.000Z", "dated", "receipts")])).toBe("receipts");
  });

  it("lets an EPOCH-stamped tree rule win every same-level tie", () => {
    // adapt.ts gives filter_tree rules `1970-01-01`, so they are older
    // than anything a user could have authored. Phase D's real timestamp
    // column changes this outcome — deliberately, but not silently.
    const tree = at("1970-01-01T00:00:00.000Z", "tree:shipping", "shipping");
    const authored = at("2020-01-01T00:00:00.000Z", "filter:receipts", "receipts");
    expect(winner([authored, tree])).toBe("shipping");
  });
});
