// Direct unit tests for the pure filter engine. These complement the
// higher-level decide-folder.test.ts cases by exercising matchByFilters
// in isolation — useful for pinning the priority-ordering, exclude-rule,
// and ReDoS-safety contracts.
import { describe, it, expect } from "vitest";
import {
  applyFilter,
  matchByFilters,
  matchByFiltersExplained,
  labelOf,
  collectMatchingLeaves,
  validateRuleNode,
  MAX_FILTER_TREE_DEPTH,
  MAX_FILTER_TREE_LEAVES,
  parseDomainList,
  filterVetoes,
  emailVetoedForFolder,
  type EmailForFilter,
} from "./filter-engine";
import type { Folder, RuleNode } from "./types";
import { makeEmailRow, makeFolder, makeRule } from "../__fixtures__/email-row";

// makeEmailRow returns the shared "email content" fields; the overrides are
// layered on top a second time so EmailForFilter-only fields it does not
// know about (reply_to_addr, origin_addr, sender_group_ids) survive.
function email(over: Partial<EmailForFilter> = {}): EmailForFilter {
  return {
    ...makeEmailRow({
      from_addr: "alice@example.com",
      from_name: "Alice",
      subject: "Hello",
      body_text: "body",
      ...over,
    }),
    ...over,
  };
}

function folder(over: Partial<Folder> = {}): Folder {
  return makeFolder({ id: "f1", ai_rule: null, ...over });
}

const filter = makeRule;

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

  // One row per selector the switch supports, each with the email shape
  // that should hit it and one that should not. Fields the classifier
  // populates from headers the ingest paths do not carry (cc, list_id,
  // reply_to) had no coverage at all, so a selector could have been
  // reading the wrong property and every rule using it silently dead.
  const selectors: Array<{
    field: string;
    value: string;
    hit: Partial<EmailForFilter>;
    miss: Partial<EmailForFilter>;
  }> = [
    {
      field: "to",
      value: "team@acme.com",
      hit: { to_addrs: "me@x.com, Team@Acme.com" },
      miss: { to_addrs: "me@x.com" },
    },
    { field: "to", value: "anything", hit: { to_addrs: "anything" }, miss: { to_addrs: "" } },
    {
      field: "cc",
      value: "legal@acme.com",
      hit: { cc: "Legal@Acme.com" },
      miss: { cc: undefined },
    },
    {
      field: "list_id",
      value: "announce.acme.com",
      hit: { list_id: "<announce.acme.com>" },
      miss: { list_id: undefined },
    },
    {
      field: "reply_to",
      value: "support@acme.com",
      hit: { reply_to_addr: "Support@Acme.com" },
      miss: { reply_to_addr: null },
    },
    {
      field: "origin_from",
      value: "real@sender.com",
      hit: { origin_addr: "Real@Sender.com", from_addr: "relay@list.test" },
      miss: { origin_addr: "other@sender.com", from_addr: "real@sender.com" },
    },
    {
      field: "origin_domain",
      value: "sender.com",
      hit: { origin_addr: "real@sender.com", from_addr: "relay@list.test" },
      miss: { origin_addr: "real@other.com", from_addr: "relay@sender.com" },
    },
    {
      field: "sender_in_group",
      value: "g-vip",
      hit: { sender_group_ids: ["g-other", "g-vip"] },
      miss: { sender_group_ids: ["g-other"] },
    },
    { field: "sender_in_group", value: "g-vip", hit: { sender_group_ids: ["g-vip"] }, miss: {} },
  ];

  it.each(selectors)("'$field' reads its own field (%#)", ({ field, value, hit, miss }) => {
    const op = field === "sender_in_group" ? "sender_in_group" : "contains";
    expect(applyFilter(email(hit), filter("f", field, op, value)), "hit").toBe(true);
    expect(applyFilter(email(miss), filter("f", field, op, value)), "miss").toBe(false);
  });

  // The origin_* fields exist so ONE rule covers both direct and relayed
  // mail: with no origin recorded they must read the From header.
  it("origin_from / origin_domain fall back to from_addr when there is no origin", () => {
    const direct = email({ from_addr: "real@sender.com", origin_addr: null });
    expect(applyFilter(direct, filter("f", "origin_from", "equals", "real@sender.com"))).toBe(true);
    expect(applyFilter(direct, filter("f", "origin_domain", "equals", "sender.com"))).toBe(true);

    const noneAtAll = email({ from_addr: "", origin_addr: null });
    expect(applyFilter(noneAtAll, filter("f", "origin_domain", "equals", ""))).toBe(true);
  });

  it("the origin, not the relay, decides once one is recorded", () => {
    const relayed = email({ from_addr: "relay@list.test", origin_addr: "real@sender.com" });
    expect(applyFilter(relayed, filter("f", "origin_domain", "equals", "sender.com"))).toBe(true);
    expect(applyFilter(relayed, filter("f", "origin_domain", "equals", "list.test"))).toBe(false);
    // The plain `domain` field still sees the relay — that is the point of
    // having both.
    expect(applyFilter(relayed, filter("f", "domain", "equals", "list.test"))).toBe(true);
  });

  it("sender_in_group is false for a sender with no resolved groups", () => {
    expect(
      applyFilter(email({ sender_group_ids: [] }), filter("f", "x", "sender_in_group", "g-vip")),
    ).toBe(false);
    expect(applyFilter(email(), filter("f", "x", "sender_in_group", "g-vip"))).toBe(false);
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

  // One case per shape in UNSAFE_REGEX_SHAPES. Each pattern is written so
  // that it WOULD match if it were allowed to run, which is what makes the
  // rejection observable rather than a coincidence of the input.
  it.each([
    ["nested quantifier (a+)+", "(a+)+", "aaaa"],
    ["nested quantifier (a*)*", "(a*)*", "aaaa"],
    ["nested quantifier inside a longer pattern", "x(ab+c)*y", "xy"],
    ["chained character classes", "[a-z]+[a-z]+", "hello"],
    ["three chained character classes", "[a-z]+[0-9]*[a-z]+", "a1b"],
    ["repeated .*", ".*.*", "anything"],
    ["three .* runs", ".*.*.*", "anything"],
  ])("rejects %s", (_name, pattern, subject) => {
    expect(applyFilter(email({ subject }), filter("f", "subject", "regex", pattern))).toBe(false);
    // Sanity: the pattern really does match when run directly, so the
    // `false` above is the guard and not the pattern.
    expect(new RegExp(pattern, "i").test(subject)).toBe(true);
  });

  it("a pattern at exactly the 200-char limit is still allowed", () => {
    const atLimit = "a".repeat(200);
    expect(
      applyFilter(email({ subject: "a".repeat(200) }), filter("f", "subject", "regex", atLimit)),
    ).toBe(true);
  });

  it("truncates the input at 10k chars, so a match past the cap does not count", () => {
    const withinCap = "x".repeat(9_990) + "needle" + "y".repeat(10_000);
    expect(
      applyFilter(email({ subject: withinCap }), filter("f", "subject", "regex", "needle")),
    ).toBe(true);

    const pastCap = "x".repeat(20_000) + "needle";
    expect(
      applyFilter(email({ subject: pastCap }), filter("f", "subject", "regex", "needle")),
    ).toBe(false);
    // Only `regex` is bounded — the plain string ops still see it all, so
    // the cap is a ReDoS guard and not a general truncation.
    expect(
      applyFilter(email({ subject: pastCap }), filter("f", "subject", "contains", "needle")),
    ).toBe(true);
  });
});

describe("domain_in allowlist", () => {
  it("parseDomainList normalizes case, @, and separators", () => {
    const set = parseDomainList("@Acme.com, foo.io ; bar.co\nAcme.com");
    expect([...set].sort()).toEqual(["acme.com", "bar.co", "foo.io"]);
  });

  it("applyFilter(domain_in) is true when sender domain is in the list", () => {
    const e = email({ from_addr: "gm@nucar.com" });
    expect(applyFilter(e, filter("f", "domain", "domain_in", "dcd.auto,nucar.com"))).toBe(true);
  });

  it("applyFilter(domain_in) is false for an external sender", () => {
    const e = email({ from_addr: "lawyer@sullivanlaw.com" });
    expect(applyFilter(e, filter("f", "domain", "domain_in", "dcd.auto,nucar.com"))).toBe(false);
  });

  it("filterVetoes: allowlist vetoes external senders, admits internal ones", () => {
    const allow = filter("f", "domain", "domain_in", "dcd.auto,nucar.com");
    expect(filterVetoes(email({ from_addr: "x@sullivanlaw.com" }), allow)).toBe(true);
    expect(filterVetoes(email({ from_addr: "x@nucar.com" }), allow)).toBe(false);
  });

  it("matchByFilters excludes a matched folder when the sender is outside the allowlist", () => {
    const r = matchByFilters(
      email({ subject: "RE: Daily Report", from_addr: "lsteinberg@sullivanlaw.com" }),
      [folder({ id: "gm", name: "GM Responses" })],
      [
        filter("gm", "subject", "starts_with", "re: daily report"),
        filter("gm", "domain", "domain_in", "dcd.auto,nucar.com"),
      ],
    );
    expect(r?.kind).toBe("excluded");
    if (r?.kind === "excluded") expect(r.exclude.op).toBe("domain_in");
  });

  it("matchByFilters keeps an internal sender that also matches an include rule", () => {
    const r = matchByFilters(
      email({ subject: "RE: Daily Report", from_addr: "gm@nucar.com" }),
      [folder({ id: "gm", name: "GM Responses" })],
      [
        filter("gm", "subject", "starts_with", "re: daily report"),
        filter("gm", "domain", "domain_in", "dcd.auto,nucar.com"),
      ],
    );
    expect(r?.kind).toBe("match");
    if (r?.kind === "match") expect(r.folder_id).toBe("gm");
  });

  it("emailVetoedForFolder blocks the AI path for an external sender", () => {
    const filters = [filter("gm", "domain", "domain_in", "dcd.auto,nucar.com")];
    expect(emailVetoedForFolder(email({ from_addr: "x@sullivanlaw.com" }), "gm", filters)).toBe(
      true,
    );
    expect(emailVetoedForFolder(email({ from_addr: "x@nucar.com" }), "gm", filters)).toBe(false);
    // A different folder's allowlist must not affect this folder.
    expect(emailVetoedForFolder(email({ from_addr: "x@sullivanlaw.com" }), "other", filters)).toBe(
      false,
    );
  });
});

// Rows ingested before the From-header parser was hardened still hold the whole
// header in from_addr. The engine derives `domain` with emailDomain(), so a
// user-typed rule like "acme.com" must still match them. The old
// `from_addr.split("@")[1]` produced "acme.com>" / "acme.com> (sales)" here and
// the rule silently never fired.
describe("domain matching on unnormalized from_addr", () => {
  const MALFORMED = [
    'Jane "JD" Doe <jane@acme.com>',
    "Jane <jane@acme.com> (Sales)",
    "Jane Doe <jane@acme.com>, Bob <bob@other.com>",
    "jane@acme.com>",
  ];

  it("domain equals matches every malformed sender shape", () => {
    for (const from_addr of MALFORMED) {
      expect(
        applyFilter(email({ from_addr }), filter("f", "domain", "equals", "acme.com")),
        `domain equals should match ${from_addr}`,
      ).toBe(true);
    }
  });

  it("domain_in allowlist admits every malformed sender shape", () => {
    for (const from_addr of MALFORMED) {
      expect(
        applyFilter(email({ from_addr }), filter("f", "domain", "domain_in", "acme.com,foo.io")),
        `domain_in should admit ${from_addr}`,
      ).toBe(true);
    }
  });

  it("domain_in still vetoes an outside sender written the same malformed way", () => {
    const allow = filter("f", "domain", "domain_in", "acme.com");
    expect(filterVetoes(email({ from_addr: 'Bob "B" <bob@evil.com> (spam)' }), allow)).toBe(true);
  });

  it("routes a malformed sender to the folder its domain rule names", () => {
    const r = matchByFilters(
      email({ from_addr: "Jane <jane@acme.com> (Sales)" }),
      [folder({ id: "clients", name: "Clients" })],
      [filter("clients", "domain", "equals", "acme.com")],
    );
    expect(r?.kind).toBe("match");
    if (r?.kind === "match") expect(r.folder_id).toBe("clients");
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

describe("filter-tree bounds (validateRuleNode)", () => {
  /** depth-N chain: group > group > … > cond. Depth counts the root. */
  function chain(depth: number): RuleNode {
    let node: RuleNode = { type: "cond", field: "subject", op: "contains", value: "x" };
    for (let i = 1; i < depth; i++) node = { type: "group", op: "and", children: [node] };
    return node;
  }
  /** flat group with N leaves that all match subject "Hello". */
  function wide(leaves: number): RuleNode {
    return {
      type: "group",
      op: "or",
      children: Array.from({ length: leaves }, () => ({
        type: "cond" as const,
        field: "subject",
        op: "contains",
        value: "hello",
      })),
    };
  }

  it("accepts trees at the depth and leaf limits", () => {
    expect(validateRuleNode(chain(MAX_FILTER_TREE_DEPTH))).toEqual({ ok: true });
    expect(validateRuleNode(wide(MAX_FILTER_TREE_LEAVES))).toEqual({ ok: true });
  });

  it("rejects a tree nested past MAX_FILTER_TREE_DEPTH", () => {
    const v = validateRuleNode(chain(MAX_FILTER_TREE_DEPTH + 1));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(`${MAX_FILTER_TREE_DEPTH} levels`);
  });

  it("rejects a tree with more than MAX_FILTER_TREE_LEAVES conditions", () => {
    const v = validateRuleNode(wide(MAX_FILTER_TREE_LEAVES + 1));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(`${MAX_FILTER_TREE_LEAVES} conditions`);
  });

  it("rejects malformed nodes with descriptive reasons", () => {
    const unknownType = { type: "nope" } as unknown as RuleNode;
    const badChildren = { type: "group", op: "and", children: "x" } as unknown as RuleNode;
    const badCond = {
      type: "cond",
      field: "subject",
      op: "contains",
      value: 5,
    } as unknown as RuleNode;
    const badOp = { type: "group", op: "xor", children: [] } as unknown as RuleNode;
    expect(validateRuleNode(unknownType)).toMatchObject({ ok: false });
    expect(validateRuleNode(badChildren)).toMatchObject({ ok: false });
    expect(validateRuleNode(badCond)).toMatchObject({ ok: false });
    expect(validateRuleNode(badOp)).toMatchObject({ ok: false });
  });

  it("an out-of-bounds tree never matches its folder (inert, no flat-filter fallback)", () => {
    const f = folder({ id: "f-big", name: "Big", filter_tree: wide(MAX_FILTER_TREE_LEAVES + 1) });
    // A flat filter that WOULD match — must not be used as a fallback for
    // the superseded tree.
    const flat = [filter("f-big", "subject", "contains", "hello")];
    expect(matchByFilters(email({ subject: "Hello there" }), [f], flat)).toBeNull();
  });

  it("a maliciously deep tree is handled without evaluating (no stack blowup)", () => {
    const f = folder({ id: "f-deep", name: "Deep", filter_tree: chain(50_000) });
    expect(matchByFilters(email({ subject: "x" }), [f], [])).toBeNull();
  });

  it("collectMatchingLeaves short-circuits on out-of-bounds trees", () => {
    expect(
      collectMatchingLeaves(email({ subject: "hello" }), wide(MAX_FILTER_TREE_LEAVES + 1)),
    ).toEqual([]);
    expect(collectMatchingLeaves(email({ subject: "hello" }), wide(3))).toHaveLength(3);
  });

  it("a tree at the limits still evaluates normally", () => {
    const f = folder({ id: "f-ok", name: "Ok", filter_tree: wide(MAX_FILTER_TREE_LEAVES) });
    const m = matchByFilters(email({ subject: "Hello there" }), [f], []);
    expect(m).toMatchObject({ kind: "match", folder_id: "f-ok", tree_used: true });
  });
});

// matchByFiltersExplained is what the decision drawer renders: it must be
// able to say why every folder LOST, not just which one won. Each verdict
// below is one of those explanations, and none of them was asserted.
describe("matchByFiltersExplained — the per-folder verdict list", () => {
  const verdictFor = (result: ReturnType<typeof matchByFiltersExplained>, folderId: string) =>
    result.candidates.find((c) => c.folder_id === folderId);

  it("'no_rules': a folder with no include rules is reported, not silently skipped", () => {
    const r = matchByFiltersExplained(
      email(),
      [],
      [folder({ id: "f-empty", name: "Empty", priority: 3 })],
      // Only an EXCLUDE row, which can veto but can never file.
      [filter("f-empty", "from", "not_contains", "nobody")],
    );
    expect(r.match).toBeNull();
    expect(verdictFor(r, "f-empty")).toStrictEqual({
      folder_id: "f-empty",
      folder_name: "Empty",
      priority: 3,
      verdict: "no_rules",
      matched: [],
    });
  });

  it("'no_match': rules exist but none fired", () => {
    const r = matchByFiltersExplained(
      email({ subject: "Hello" }),
      [],
      [folder({ id: "f1", name: "Nope" })],
      [filter("f1", "subject", "contains", "invoice")],
    );
    expect(verdictFor(r, "f1")).toMatchObject({ verdict: "no_match", matched: [] });
  });

  it("'invalid_tree': an out-of-bounds tree is reported as inert, not as no_match", () => {
    const tree: RuleNode = {
      type: "group",
      op: "or",
      children: Array.from({ length: MAX_FILTER_TREE_LEAVES + 1 }, () => ({
        type: "cond" as const,
        field: "subject",
        op: "contains",
        value: "hello",
      })),
    };
    const r = matchByFiltersExplained(
      email({ subject: "hello" }),
      [],
      [folder({ id: "f-bad", name: "Bad", filter_tree: tree })],
      [],
    );
    expect(verdictFor(r, "f-bad")).toMatchObject({ verdict: "invalid_tree" });
  });

  it("'paused': a paused folder is reported before any rule is consulted", () => {
    const r = matchByFiltersExplained(
      email({ subject: "invoice" }),
      [],
      [folder({ id: "f-off", name: "Off", processing_enabled: false })],
      [filter("f-off", "subject", "contains", "invoice")],
    );
    expect(r.match).toBeNull();
    expect(verdictFor(r, "f-off")).toMatchObject({ verdict: "paused" });
  });

  it("'matched' carries the leaves that fired", () => {
    const r = matchByFiltersExplained(
      email({ subject: "Invoice 42", from_addr: "billing@acme.com" }),
      [],
      [folder({ id: "f1", name: "Invoices" })],
      [
        filter("f1", "subject", "contains", "invoice"),
        filter("f1", "domain", "contains", "acme.com"),
        filter("f1", "subject", "contains", "never"),
      ],
    );
    expect(verdictFor(r, "f1")).toMatchObject({
      verdict: "matched",
      via_thread: false,
      matched: [
        { field: "subject", op: "contains", value: "invoice" },
        { field: "domain", op: "contains", value: "acme.com" },
      ],
    });
  });

  it("'vetoed' names the exclude rule that disqualified the folder", () => {
    const r = matchByFiltersExplained(
      email({ subject: "Promo code", from_addr: "internal@acme.com" }),
      [],
      [folder({ id: "f1", name: "Marketing" })],
      [
        filter("f1", "subject", "contains", "promo"),
        filter("f1", "from", "not_contains", "internal"),
      ],
    );
    expect(verdictFor(r, "f1")).toMatchObject({
      verdict: "vetoed",
      veto: { field: "from", op: "not_contains", value: "internal" },
    });
  });

  it("'via_thread': the folder matched only on a PRIOR message of the thread", () => {
    const threaded = folder({ id: "f-thread", name: "Deals", run_on_threads: true });
    const prior = [email({ subject: "The contract draft" })];
    const r = matchByFiltersExplained(
      email({ subject: "Re: following up" }),
      prior,
      [threaded],
      [filter("f-thread", "subject", "contains", "contract")],
    );
    expect(r.match).toMatchObject({
      kind: "match",
      folder_id: "f-thread",
      matched_via_thread: true,
    });
    expect(verdictFor(r, "f-thread")).toMatchObject({ verdict: "matched", via_thread: true });
  });

  it("via_thread is false when the incoming message matched on its own", () => {
    const threaded = folder({ id: "f-thread", name: "Deals", run_on_threads: true });
    const r = matchByFiltersExplained(
      email({ subject: "The contract, signed" }),
      [email({ subject: "The contract draft" })],
      [threaded],
      [filter("f-thread", "subject", "contains", "contract")],
    );
    expect(r.match).toMatchObject({ matched_via_thread: false });
    expect(verdictFor(r, "f-thread")).toMatchObject({ via_thread: false });
  });

  it("a folder without run_on_threads never matches on a prior message", () => {
    const r = matchByFiltersExplained(
      email({ subject: "Re: following up" }),
      [email({ subject: "The contract draft" })],
      [folder({ id: "f-msg", name: "Message scoped" })],
      [filter("f-msg", "subject", "contains", "contract")],
    );
    expect(r.match).toBeNull();
    expect(verdictFor(r, "f-msg")).toMatchObject({ verdict: "no_match" });
  });
});

describe("matchByFilters — two folders vetoed at once", () => {
  const promo = () => email({ subject: "Promo code inside", from_addr: "internal@acme.com" });
  const rulesFor = (id: string) => [
    filter(id, "subject", "contains", "promo"),
    filter(id, "from", "not_contains", "internal"),
  ];

  it("reports the HIGHEST-priority vetoed folder, so the drawer explains the best candidate", () => {
    const r = matchByFilters(
      promo(),
      [
        folder({ id: "low", name: "Low", priority: 1 }),
        folder({ id: "high", name: "High", priority: 9 }),
      ],
      [...rulesFor("low"), ...rulesFor("high")],
    );
    expect(r).toMatchObject({ kind: "excluded", folder_id: "high", folder_name: "High" });
  });

  it("breaks a priority tie by folder name ascending, exactly as the match path does", () => {
    const r = matchByFilters(
      promo(),
      [
        folder({ id: "zeta", name: "Zeta", priority: 5 }),
        folder({ id: "alpha", name: "Alpha", priority: 5 }),
      ],
      [...rulesFor("zeta"), ...rulesFor("alpha")],
    );
    expect(r).toMatchObject({ kind: "excluded", folder_id: "alpha" });
  });

  it("one folder matching outranks any number of vetoed folders", () => {
    const r = matchByFilters(
      promo(),
      [
        folder({ id: "vetoed", name: "Vetoed", priority: 9 }),
        folder({ id: "open", name: "Open", priority: 1 }),
      ],
      [...rulesFor("vetoed"), filter("open", "subject", "contains", "promo")],
    );
    expect(r).toMatchObject({ kind: "match", folder_id: "open" });
  });
});
