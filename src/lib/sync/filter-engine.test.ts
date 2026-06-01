// Direct unit tests for the pure filter engine. These complement the
// higher-level sync-classify.test.ts cases by exercising matchByFilters
// in isolation — useful for pinning the priority-ordering, exclude-rule,
// and ReDoS-safety contracts.
import { describe, it, expect } from "vitest";
import {
  applyFilter,
  matchByFilters,
  labelOf,
  collectMatchingLeaves,
  EXCLUDE_OPS,
  type EmailForFilter,
} from "./filter-engine";
import type { Filter, Folder, RuleNode } from "./types";

function email(over: Partial<EmailForFilter> = {}): EmailForFilter {
  return {
    from_addr: "alice@example.com",
    from_name: "Alice",
    to_addrs: "me@example.com",
    subject: "Hello",
    body_text: "body",
    has_attachment: false,
    ...over,
  };
}

function folder(over: Partial<Folder> = {}): Folder {
  return {
    id: over.id ?? "f1",
    name: over.name ?? "Default",
    gmail_label_id: over.gmail_label_id ?? null,
    ai_rule: over.ai_rule ?? null,
    learned_profile: over.learned_profile ?? null,
    last_learned_at: over.last_learned_at ?? null,
    auto_archive: over.auto_archive ?? false,
    auto_mark_read: over.auto_mark_read ?? false,
    auto_star: over.auto_star ?? false,
    hide_from_inbox: over.hide_from_inbox ?? false,
    skip_ai: over.skip_ai ?? false,
    priority: over.priority ?? 0,
    gmail_account_id: over.gmail_account_id ?? "acc-1",
    filter_logic: over.filter_logic ?? "any",
    filter_tree: over.filter_tree ?? null,
    forward_to: over.forward_to ?? null,
    min_ai_confidence: over.min_ai_confidence ?? 0,
    snooze_hours: over.snooze_hours ?? 0,
    overrides_inbox_override: over.overrides_inbox_override ?? false,
    is_cold_email: over.is_cold_email ?? false,
  };
}

function filter(folder_id: string, field: string, op: string, value: string, id?: string): Filter {
  return { id: id ?? `${folder_id}-${field}-${value}`, folder_id, field, op, value };
}

describe("applyFilter — field selectors", () => {
  it("'from' combines from_addr and from_name (case-insensitive)", () => {
    const e = email({ from_addr: "BOB@x.com", from_name: "Bob Smith" });
    expect(applyFilter(e, filter("f", "from", "contains", "smith"))).toBe(true);
    expect(applyFilter(e, filter("f", "from", "contains", "BOB"))).toBe(true);
    expect(applyFilter(e, filter("f", "from", "contains", "nope"))).toBe(false);
  });

  it("'domain' extracts the @-suffix", () => {
    expect(
      applyFilter(email({ from_addr: "a@acme.com" }), filter("f", "domain", "equals", "acme.com")),
    ).toBe(true);
    expect(
      applyFilter(email({ from_addr: "a@x.com" }), filter("f", "domain", "equals", "acme.com")),
    ).toBe(false);
  });

  it("'is_reply' returns 'true' / 'false' based on in_reply_to", () => {
    expect(
      applyFilter(email({ in_reply_to: "<m@x>" }), filter("f", "is_reply", "equals", "true")),
    ).toBe(true);
    expect(
      applyFilter(email({ in_reply_to: undefined }), filter("f", "is_reply", "equals", "false")),
    ).toBe(true);
  });

  it("'has_attachment' returns boolean-as-string", () => {
    expect(
      applyFilter(email({ has_attachment: true }), filter("f", "has_attachment", "equals", "true")),
    ).toBe(true);
    expect(
      applyFilter(
        email({ has_attachment: false }),
        filter("f", "has_attachment", "equals", "true"),
      ),
    ).toBe(false);
  });

  it("unknown field returns false (defensive)", () => {
    expect(applyFilter(email(), filter("f", "nonexistent", "contains", "x"))).toBe(false);
  });
});

describe("applyFilter — operators", () => {
  const e = email({ subject: "Hello world" });

  it("contains / not_contains", () => {
    expect(applyFilter(e, filter("f", "subject", "contains", "world"))).toBe(true);
    expect(applyFilter(e, filter("f", "subject", "not_contains", "world"))).toBe(false);
    expect(applyFilter(e, filter("f", "subject", "not_contains", "ABSENT"))).toBe(true);
  });

  it("equals / not_equals are exact (case-insensitive)", () => {
    expect(applyFilter(e, filter("f", "subject", "equals", "hello world"))).toBe(true);
    expect(applyFilter(e, filter("f", "subject", "equals", "hello"))).toBe(false);
    expect(applyFilter(e, filter("f", "subject", "not_equals", "anything"))).toBe(true);
  });

  it("starts_with / ends_with", () => {
    expect(applyFilter(e, filter("f", "subject", "starts_with", "hello"))).toBe(true);
    expect(applyFilter(e, filter("f", "subject", "ends_with", "world"))).toBe(true);
    expect(applyFilter(e, filter("f", "subject", "starts_with", "world"))).toBe(false);
  });

  it("regex evaluates against the lowered field value", () => {
    expect(applyFilter(e, filter("f", "subject", "regex", "^hello"))).toBe(true);
    expect(applyFilter(e, filter("f", "subject", "regex", "WORLD$"))).toBe(true); // i flag
  });

  it("unknown op returns false", () => {
    expect(applyFilter(e, filter("f", "subject", "bogus_op", "anything"))).toBe(false);
  });
});

describe("applyFilter — regex safety (ReDoS)", () => {
  it("rejects nested-quantifier patterns without throwing", () => {
    const e = email({ subject: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaa!" });
    // Classic catastrophic backtracking shape — should be rejected.
    expect(applyFilter(e, filter("f", "subject", "regex", "(a+)+$"))).toBe(false);
    expect(applyFilter(e, filter("f", "subject", "regex", "(a*)*$"))).toBe(false);
  });

  it("rejects patterns longer than 200 chars", () => {
    const longPattern = "a".repeat(201);
    expect(applyFilter(email(), filter("f", "subject", "regex", longPattern))).toBe(false);
  });

  it("safely returns false for malformed regex syntax", () => {
    expect(applyFilter(email(), filter("f", "subject", "regex", "[unclosed"))).toBe(false);
  });

  it("accepts normal regex patterns", () => {
    expect(
      applyFilter(email({ subject: "ABC-123" }), filter("f", "subject", "regex", "^[a-z]+-\\d+$")),
    ).toBe(true);
  });
});

describe("EXCLUDE_OPS set", () => {
  it("contains exactly not_contains + not_equals", () => {
    expect(EXCLUDE_OPS.has("not_contains")).toBe(true);
    expect(EXCLUDE_OPS.has("not_equals")).toBe(true);
    // Sanity — other ops shouldn't be excluded.
    expect(EXCLUDE_OPS.has("contains")).toBe(false);
    expect(EXCLUDE_OPS.has("equals")).toBe(false);
    expect(EXCLUDE_OPS.has("regex")).toBe(false);
  });
});

describe("matchByFilters — basic routing", () => {
  it("returns null when no folder matches", () => {
    const r = matchByFilters(
      email(),
      [folder({ id: "f1" })],
      [filter("f1", "subject", "contains", "absent")],
    );
    expect(r).toBeNull();
  });

  it("returns kind='match' when a single folder matches", () => {
    const r = matchByFilters(
      email({ subject: "Invoice 42" }),
      [folder({ id: "f1", name: "Bills" })],
      [filter("f1", "subject", "contains", "invoice")],
    );
    expect(r?.kind).toBe("match");
    if (r?.kind === "match") expect(r.folder_id).toBe("f1");
  });

  it("returns kind='excluded' when a folder would match but is vetoed by a not_contains rule", () => {
    const r = matchByFilters(
      email({ subject: "promo deal", from_addr: "internal@x.com" }),
      [folder({ id: "f1", name: "Promos" })],
      [
        filter("f1", "subject", "contains", "promo"),
        filter("f1", "from", "not_contains", "internal"),
      ],
    );
    expect(r?.kind).toBe("excluded");
    if (r?.kind === "excluded") expect(r.folder_name).toBe("Promos");
  });
});

describe("matchByFilters — priority and tiebreak", () => {
  it("higher priority wins when multiple folders match", () => {
    const r = matchByFilters(
      email({ subject: "X" }),
      [folder({ id: "low", priority: 0 }), folder({ id: "high", priority: 5 })],
      [filter("low", "subject", "contains", "X"), filter("high", "subject", "contains", "X")],
    );
    expect(r?.kind).toBe("match");
    if (r?.kind === "match") expect(r.folder_id).toBe("high");
  });

  it("ties break by folder name ascending (stable order)", () => {
    const r = matchByFilters(
      email({ subject: "X" }),
      [
        folder({ id: "z", name: "Zebra", priority: 1 }),
        folder({ id: "a", name: "Aardvark", priority: 1 }),
      ],
      [filter("z", "subject", "contains", "X"), filter("a", "subject", "contains", "X")],
    );
    expect(r?.kind).toBe("match");
    if (r?.kind === "match") expect(r.folder_id).toBe("a");
  });

  it("all_matched_folder_ids includes every folder that matched, in priority order", () => {
    const r = matchByFilters(
      email({ subject: "X" }),
      [
        folder({ id: "low", priority: 0 }),
        folder({ id: "mid", priority: 5 }),
        folder({ id: "high", priority: 10 }),
      ],
      [
        filter("low", "subject", "contains", "X"),
        filter("mid", "subject", "contains", "X"),
        filter("high", "subject", "contains", "X"),
      ],
    );
    if (r?.kind !== "match") throw new Error("expected match");
    expect(r.all_matched_folder_ids).toEqual(["high", "mid", "low"]);
  });
});

describe("matchByFilters — filter logic (any vs all)", () => {
  it("'any' (default) passes when at least one include hits", () => {
    const r = matchByFilters(
      email({ subject: "Invoice 42", from_addr: "x@y.com" }),
      [folder({ id: "f1", filter_logic: "any" })],
      [filter("f1", "subject", "contains", "invoice"), filter("f1", "from", "contains", "billing")],
    );
    expect(r?.kind).toBe("match");
  });

  it("'all' requires every include to match", () => {
    const folders = [folder({ id: "f1", filter_logic: "all" })];
    const filters = [
      filter("f1", "subject", "contains", "invoice"),
      filter("f1", "from", "contains", "billing"),
    ];
    // Only one hits — should not match.
    expect(
      matchByFilters(email({ subject: "Invoice", from_addr: "x@y.com" }), folders, filters),
    ).toBeNull();
    // Both hit — match.
    const r = matchByFilters(
      email({ subject: "Invoice", from_addr: "billing@y.com" }),
      folders,
      filters,
    );
    expect(r?.kind).toBe("match");
  });
});

describe("matchByFilters — filter_tree (rule groups)", () => {
  const treeMatch: RuleNode = {
    type: "group",
    op: "and",
    children: [
      { type: "cond", field: "from", op: "contains", value: "@acme.com" },
      {
        type: "group",
        op: "or",
        children: [
          { type: "cond", field: "subject", op: "contains", value: "invoice" },
          { type: "cond", field: "subject", op: "contains", value: "receipt" },
        ],
      },
    ],
  };

  it("filter_tree takes precedence over flat filters and reports tree_used=true", () => {
    const r = matchByFilters(
      email({ from_addr: "billing@acme.com", subject: "Invoice 42" }),
      [folder({ id: "f1", filter_tree: treeMatch })],
      // Add a flat filter too — it should be ignored when tree exists.
      [filter("f1", "from", "contains", "totally-different")],
    );
    expect(r?.kind).toBe("match");
    if (r?.kind === "match") {
      expect(r.tree_used).toBe(true);
      expect(r.matched_filters).toEqual([]);
    }
  });

  it("empty tree (group with no conds) falls back to flat filter handling", () => {
    const emptyTree: RuleNode = { type: "group", op: "and", children: [] };
    const r = matchByFilters(
      email({ subject: "X" }),
      [folder({ id: "f1", filter_tree: emptyTree })],
      [filter("f1", "subject", "contains", "X")],
    );
    expect(r?.kind).toBe("match");
    if (r?.kind === "match") expect(r.tree_used).toBe(false);
  });
});

describe("labelOf", () => {
  it("returns the folder name for a known id", () => {
    expect(labelOf([folder({ id: "f1", name: "Invoices" })], "f1")).toBe("Invoices");
  });
  it("returns the literal 'folder' for unknown ids", () => {
    expect(labelOf([], "missing")).toBe("folder");
  });
});

describe("collectMatchingLeaves", () => {
  const tree: RuleNode = {
    type: "group",
    op: "or",
    children: [
      { type: "cond", field: "domain", op: "contains", value: "docusign" },
      { type: "cond", field: "subject", op: "starts_with", value: "Completed" },
    ],
  };

  it("returns only the leaves that match", () => {
    const e = email({ from_addr: "dse@docusign.net", subject: "Hello there" });
    const leaves = collectMatchingLeaves(e, tree);
    expect(leaves).toEqual([{ field: "domain", op: "contains", value: "docusign" }]);
  });

  it("returns multiple leaves when several match", () => {
    const e = email({ from_addr: "dse@docusign.net", subject: "Completed: doc" });
    expect(collectMatchingLeaves(e, tree)).toHaveLength(2);
  });

  it("returns empty when no leaf matches", () => {
    const e = email({ from_addr: "alice@example.com", subject: "Hi" });
    expect(collectMatchingLeaves(e, tree)).toEqual([]);
  });

  it("walks nested groups", () => {
    const nested: RuleNode = {
      type: "group",
      op: "and",
      children: [
        { type: "cond", field: "subject", op: "contains", value: "credit" },
        {
          type: "group",
          op: "or",
          children: [
            { type: "cond", field: "domain", op: "equals", value: "docusign.net" },
            { type: "cond", field: "from", op: "contains", value: "noreply" },
          ],
        },
      ],
    };
    const e = email({ from_addr: "dse@docusign.net", subject: "credit app" });
    const leaves = collectMatchingLeaves(e, nested);
    expect(leaves).toEqual([
      { field: "subject", op: "contains", value: "credit" },
      { field: "domain", op: "equals", value: "docusign.net" },
    ]);
  });
});
