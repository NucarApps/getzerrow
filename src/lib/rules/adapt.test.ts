import { describe, expect, it } from "vitest";
import { toGuardrails, toPins, toRules, treeToGroups } from "./adapt";
import type { Filter, Folder } from "../sync/types";

const folder = (over: Partial<Folder> & Pick<Folder, "id" | "name">): Folder =>
  ({
    gmail_label_id: null,
    ai_rule: null,
    learned_profile: null,
    last_learned_at: null,
    auto_archive: false,
    auto_mark_read: false,
    auto_star: false,
    hide_from_inbox: false,
    skip_ai: false,
    priority: 0,
    gmail_account_id: "acc",
    filter_logic: "any",
    filter_tree: null,
    forward_to: null,
    min_ai_confidence: 0.7,
    snooze_hours: 0,
    overrides_inbox_override: false,
    is_cold_email: false,
    surface_ai_rule: null,
    surface_names: null,
    ...over,
  }) as Folder;

const filter = (over: Partial<Filter> & Pick<Filter, "id" | "folder_id">): Filter => ({
  field: "domain",
  op: "contains",
  value: "amazon.com",
  ...over,
});

describe("toRules", () => {
  it('splits filter_logic="any" into one rule per condition so each keeps its own level', () => {
    const rules = toRules(
      [folder({ id: "f1", name: "Receipts" })],
      [
        filter({ id: "a", folder_id: "f1" }),
        filter({ id: "b", folder_id: "f1", field: "from", value: "billing@amazon.com" }),
      ],
    );
    expect(rules.map((r) => [r.id, r.specificity_level])).toEqual([
      ["a", 3],
      ["b", 1],
    ]);
  });

  it('collapses filter_logic="all" into one conjunction', () => {
    const rules = toRules(
      [folder({ id: "f1", name: "Receipts", filter_logic: "all" })],
      [
        filter({ id: "a", folder_id: "f1" }),
        filter({ id: "b", folder_id: "f1", field: "subject", value: "receipt" }),
      ],
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]!.groups[0]).toHaveLength(2);
    expect(rules[0]!.specificity_level).toBe(3);
  });

  it("excludes veto ops from the rule set", () => {
    const rules = toRules(
      [folder({ id: "f1", name: "Receipts" })],
      [filter({ id: "x", folder_id: "f1", op: "not_contains" })],
    );
    expect(rules).toHaveLength(0);
  });

  // The ladder's last-resort tiebreak is "the older rule wins", so a rule
  // that reaches the resolver stamped with the epoch has no age at all and
  // ties fall through to lexicographic rule-id order.
  describe("rule age", () => {
    it("carries each folder_filters row's own created_at", () => {
      const rules = toRules(
        [folder({ id: "f1", name: "Receipts" })],
        [
          filter({ id: "a", folder_id: "f1", created_at: "2026-03-01T00:00:00.000Z" }),
          filter({
            id: "b",
            folder_id: "f1",
            field: "from",
            value: "billing@amazon.com",
            created_at: "2025-11-02T00:00:00.000Z",
          }),
        ],
      );
      expect(rules.map((r) => [r.id, r.created_at])).toEqual([
        ["a", "2026-03-01T00:00:00.000Z"],
        ["b", "2025-11-02T00:00:00.000Z"],
      ]);
    });

    it('an "all" folder is as old as its OLDEST condition', () => {
      const rules = toRules(
        [folder({ id: "f1", name: "Receipts", filter_logic: "all" })],
        [
          filter({ id: "a", folder_id: "f1", created_at: "2026-03-01T00:00:00.000Z" }),
          filter({
            id: "b",
            folder_id: "f1",
            field: "subject",
            value: "receipt",
            created_at: "2025-11-02T00:00:00.000Z",
          }),
        ],
      );
      expect(rules[0]!.created_at).toBe("2025-11-02T00:00:00.000Z");
    });

    it("falls back to the epoch for a row with no timestamp, or an unparseable one", () => {
      const rules = toRules(
        [folder({ id: "f1", name: "Receipts", filter_logic: "all" })],
        [
          filter({ id: "a", folder_id: "f1" }),
          filter({ id: "b", folder_id: "f1", field: "subject", created_at: "not a date" }),
        ],
      );
      expect(rules[0]!.created_at).toBe("1970-01-01T00:00:00.000Z");
    });

    // CHARACTERIZATION(engine-tree-rule-has-no-age): folders.filter_tree is a
    // JSON column with no authoring timestamp, so a tree rule is stamped with
    // the epoch and wins every same-level tie against a real, older rule.
    it("a filter_tree rule is stamped with the epoch, so it out-ages every real rule", () => {
      const rules = toRules(
        [
          folder({
            id: "f1",
            name: "Receipts",
            filter_tree: { type: "cond", field: "domain", op: "contains", value: "amazon.com" },
          }),
        ],
        [],
      );
      expect(rules[0]!.created_at).toBe("1970-01-01T00:00:00.000Z");
    });
  });
});

describe("toGuardrails", () => {
  it("maps exclude ops to folder-scoped guardrails", () => {
    const guards = toGuardrails([
      filter({ id: "x", folder_id: "f1", op: "not_contains", value: "internal" }),
      filter({ id: "y", folder_id: "f1" }),
    ]);
    expect(guards).toEqual([
      {
        id: "x",
        scope: "folder",
        kind: "exclusion",
        folder_id: "f1",
        condition: { field: "domain", op: "not_contains", value: "internal" },
      },
    ]);
  });
});

describe("toPins", () => {
  it("maps always-inbox overrides to inbox pins", () => {
    expect(
      toPins([
        { id: "o1", match_type: "email", value: "a@b.com" },
        { id: "o2", match_type: "domain", value: "b.com" },
      ]),
    ).toEqual([
      { id: "o1", kind: "inbox", match: "email", value: "a@b.com" },
      { id: "o2", kind: "inbox", match: "domain", value: "b.com" },
    ]);
  });
});

describe("treeToGroups", () => {
  it("turns an OR of ANDs into groups", () => {
    expect(
      treeToGroups({
        type: "group",
        op: "or",
        children: [
          {
            type: "group",
            op: "and",
            children: [
              { type: "cond", field: "domain", op: "contains", value: "a.com" },
              { type: "cond", field: "subject", op: "contains", value: "x" },
            ],
          },
          { type: "cond", field: "from", op: "equals", value: "z@y.com" },
        ],
      }),
    ).toEqual([
      [
        { field: "domain", op: "contains", value: "a.com" },
        { field: "subject", op: "contains", value: "x" },
      ],
      [{ field: "from", op: "equals", value: "z@y.com" }],
    ]);
  });

  it("returns nothing for a null tree", () => {
    expect(treeToGroups(null)).toEqual([]);
  });

  // Declared narrowing, not a bug: cross-producting AND(a, OR(b,c)) into
  // [[a,b],[a,c]] is exponential in the nesting depth, so an AND node
  // concatenates its children's leaves into one conjunction instead. The
  // engine therefore matches STRICTLY LESS than the legacy tree walker
  // (which evaluates a && (b || c)) — a folder can never over-match under
  // the engine, only under-match. The cost is asserted end-to-end as an
  // engineDelta in sync/__fixtures__/folder-scenarios.ts.
  it("flattens AND(a, OR(b, c)) into one AND(a, b, c) group rather than cross-producting", () => {
    expect(
      treeToGroups({
        type: "group",
        op: "and",
        children: [
          { type: "cond", field: "from", op: "contains", value: "boss@acme.com" },
          {
            type: "group",
            op: "or",
            children: [
              { type: "cond", field: "subject", op: "contains", value: "invoice" },
              { type: "cond", field: "subject", op: "contains", value: "receipt" },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        { field: "from", op: "contains", value: "boss@acme.com" },
        { field: "subject", op: "contains", value: "invoice" },
        { field: "subject", op: "contains", value: "receipt" },
      ],
    ]);
  });
});
