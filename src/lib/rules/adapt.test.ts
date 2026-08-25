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
});
