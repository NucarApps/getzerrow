// The shared preview/backfill predicate builder (rule-query.ts).
//
// Contract: the live count in "Filter messages like this" and the actual
// apply-to-past backfill can NEVER disagree about what a rule matches —
// both go through applySimpleRulePredicate (rules.functions.ts calls it
// from the count path AND the backfill path). These tests pin the exact
// PostgREST predicate each field/op combination produces, the LIKE-
// metacharacter escaping (a raw `%`/`_` would silently widen the match),
// and the reserved-character fallback on the `or()` branch (a value with
// `( ) ,` cannot ride inside a PostgREST or() expression — it must degrade
// to the origin column alone, never to a broken filter).
import { describe, expect, it } from "vitest";
import {
  applySimpleRulePredicate,
  isOriginField,
  normalizeRuleValue,
  type SimpleRuleField,
  type SimpleRuleOp,
} from "./rule-query";
import { applyFilter } from "../sync/filter-engine";

type Call = { method: "ilike" | "or"; args: string[] };

function recorder() {
  const calls: Call[] = [];
  const qb = {
    ilike(column: string, pattern: string) {
      calls.push({ method: "ilike", args: [column, pattern] });
      return qb;
    },
    or(filter: string) {
      calls.push({ method: "or", args: [filter] });
      return qb;
    },
  };
  return { qb, calls };
}

function predicateFor(field: SimpleRuleField, op: SimpleRuleOp, value: string): Call[] {
  const { qb, calls } = recorder();
  applySimpleRulePredicate(qb, field, op, value);
  return calls;
}

describe("applySimpleRulePredicate", () => {
  it("subject: contains / equals / starts_with map to the three ILIKE shapes", () => {
    expect(predicateFor("subject", "contains", "invoice")).toEqual([
      { method: "ilike", args: ["subject", "%invoice%"] },
    ]);
    expect(predicateFor("subject", "equals", "invoice")).toEqual([
      { method: "ilike", args: ["subject", "invoice"] },
    ]);
    expect(predicateFor("subject", "starts_with", "invoice")).toEqual([
      { method: "ilike", args: ["subject", "invoice%"] },
    ]);
  });

  it("from: matches from_addr; equals still uses a bounded contains-style pattern", () => {
    expect(predicateFor("from", "contains", "boss@acme.com")).toEqual([
      { method: "ilike", args: ["from_addr", "%boss@acme.com%"] },
    ]);
    expect(predicateFor("from", "starts_with", "boss")).toEqual([
      { method: "ilike", args: ["from_addr", "boss%"] },
    ]);
    // `equals` on from falls into the same %…% shape as contains (the `pat`
    // branch has no equals arm); what that costs is pinned below under
    // rule-preview-from-equals-is-substring.
    expect(predicateFor("from", "equals", "boss@acme.com")).toEqual([
      { method: "ilike", args: ["from_addr", "%boss@acme.com%"] },
    ]);
  });

  it("domain: anchors on @ regardless of op", () => {
    for (const op of ["contains", "equals", "starts_with"] as const) {
      expect(predicateFor("domain", op, "acme.com")).toEqual([
        { method: "ilike", args: ["from_addr", "%@acme.com%"] },
      ]);
    }
  });

  it("origin fields: or() over origin_addr with from_addr fallback for null origins", () => {
    expect(predicateFor("origin_from", "contains", "boss@acme.com")).toEqual([
      {
        method: "or",
        args: [
          "origin_addr.ilike.%boss@acme.com%,and(origin_addr.is.null,from_addr.ilike.%boss@acme.com%)",
        ],
      },
    ]);
    expect(predicateFor("origin_domain", "starts_with", "acme.com")).toEqual([
      {
        method: "or",
        args: [
          "origin_addr.ilike.%@acme.com%,and(origin_addr.is.null,from_addr.ilike.%@acme.com%)",
        ],
      },
    ]);
  });

  it("escapes LIKE metacharacters so % _ \\ cannot widen the match", () => {
    expect(predicateFor("subject", "contains", "100%_done\\")).toEqual([
      { method: "ilike", args: ["subject", "%100\\%\\_done\\\\%"] },
    ]);
    expect(predicateFor("domain", "contains", "foo_bar.com")).toEqual([
      { method: "ilike", args: ["from_addr", "%@foo\\_bar.com%"] },
    ]);
  });

  it("origin value carrying PostgREST-reserved chars degrades to origin column only, never a broken or()", () => {
    // `(`, `)`, `,` cannot ride inside a PostgREST or() expression.
    for (const hostile of ["a(b", "a)b", "a,b"]) {
      const calls = predicateFor("origin_from", "contains", hostile);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("ilike");
      expect(calls[0]!.args[0]).toBe("origin_addr");
    }
  });
});

// ─── Preview SQL vs. the live engine ─────────────────────────────────────
//
// The preview count and the apply-to-past backfill both go through
// applySimpleRulePredicate, so they agree with each other by construction.
// The interesting question is whether they agree with the thing that
// actually files mail: sync/filter-engine.ts `applyFilter`. A user reads
// "matches 412 messages", saves the rule, and then the engine decides what
// arrives. Where the two disagree, the preview is a lie.
//
// Each row below runs the SAME (field, op, value) through both sides
// against the same email row. Agreements are asserted as agreements;
// every divergence is a registered CHARACTERIZATION below.

/** A row as `emails` stores it, reduced to what either side reads. */
type Row = {
  from_addr: string;
  from_name?: string;
  subject?: string;
  origin_addr?: string | null;
};

function escapeRe(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Postgres ILIKE semantics: `%` any run, `_` one char, `\` escapes both. */
function ilikeMatches(pattern: string, value: string): boolean {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[++i];
      out += next === undefined ? "\\\\" : escapeRe(next);
      continue;
    }
    if (ch === "%") out += "[\\s\\S]*";
    else if (ch === "_") out += "[\\s\\S]";
    else out += escapeRe(ch);
  }
  return new RegExp(`^${out}$`, "i").test(value);
}

/** Evaluate the predicate the preview builds against one row. */
function previewMatches(
  field: SimpleRuleField,
  op: SimpleRuleOp,
  value: string,
  row: Row,
): boolean {
  const column = (name: string): string => {
    if (name === "subject") return row.subject ?? "";
    if (name === "origin_addr") return row.origin_addr ?? "";
    return row.from_addr;
  };
  return predicateFor(field, op, value).every((call) => {
    if (call.method === "ilike") return ilikeMatches(call.args[1]!, column(call.args[0]!));
    // or(): `origin_addr.ilike.P,and(origin_addr.is.null,from_addr.ilike.P)`
    const m = /^origin_addr\.ilike\.(.*),and\(origin_addr\.is\.null,from_addr\.ilike\.(.*)\)$/.exec(
      call.args[0]!,
    );
    expect(m, `unrecognised or() shape: ${call.args[0]}`).not.toBeNull();
    const [, originPat, fallbackPat] = m!;
    if (row.origin_addr) return ilikeMatches(originPat!, row.origin_addr);
    return ilikeMatches(fallbackPat!, row.from_addr);
  });
}

/** Evaluate the same rule the way the classifier does. */
function engineMatches(field: SimpleRuleField, op: SimpleRuleOp, value: string, row: Row): boolean {
  return applyFilter(
    {
      from_addr: row.from_addr,
      from_name: row.from_name ?? "",
      to_addrs: "",
      subject: row.subject ?? "",
      body_text: "",
      has_attachment: false,
      origin_addr: row.origin_addr ?? null,
    },
    { id: "", folder_id: "", field, op, value },
  );
}

describe("preview predicate vs. the engine that actually files the mail", () => {
  const agreeing: Array<[SimpleRuleField, SimpleRuleOp, string, Row, boolean]> = [
    ["subject", "contains", "invoice", { from_addr: "a@b.c", subject: "Your Invoice #7" }, true],
    ["subject", "contains", "invoice", { from_addr: "a@b.c", subject: "Receipt" }, false],
    ["subject", "equals", "invoice", { from_addr: "a@b.c", subject: "Invoice" }, true],
    ["subject", "equals", "invoice", { from_addr: "a@b.c", subject: "Invoice #7" }, false],
    ["subject", "starts_with", "re:", { from_addr: "a@b.c", subject: "Re: hello" }, true],
    ["subject", "starts_with", "re:", { from_addr: "a@b.c", subject: "Fwd: Re: hi" }, false],
    ["from", "contains", "boss@acme.com", { from_addr: "boss@acme.com" }, true],
    ["from", "contains", "boss@acme.com", { from_addr: "other@acme.com" }, false],
    ["from", "starts_with", "boss", { from_addr: "boss@acme.com" }, true],
    ["from", "starts_with", "boss", { from_addr: "theboss@acme.com" }, false],
    ["domain", "contains", "acme.com", { from_addr: "boss@acme.com" }, true],
    ["domain", "contains", "acme.com", { from_addr: "boss@other.com" }, false],
    [
      "origin_from",
      "equals",
      "boss@acme.com",
      { from_addr: "x@y.z", origin_addr: "boss@acme.com" },
      true,
    ],
    [
      "origin_from",
      "equals",
      "boss@acme.com",
      { from_addr: "x@y.z", origin_addr: "bob@acme.com" },
      false,
    ],
    // Null origin falls back to from_addr on BOTH sides.
    [
      "origin_from",
      "equals",
      "boss@acme.com",
      { from_addr: "boss@acme.com", origin_addr: null },
      true,
    ],
    ["origin_from", "contains", "acme", { from_addr: "x@y.z", origin_addr: "boss@acme.com" }, true],
    [
      "origin_from",
      "starts_with",
      "boss",
      { from_addr: "x@y.z", origin_addr: "boss@acme.com" },
      true,
    ],
    [
      "origin_from",
      "starts_with",
      "boss",
      { from_addr: "x@y.z", origin_addr: "theboss@acme.com" },
      false,
    ],
    [
      "origin_domain",
      "contains",
      "acme.com",
      { from_addr: "x@y.z", origin_addr: "boss@acme.com" },
      true,
    ],
  ];

  it.each(agreeing)("%s %s %j agrees on %j (both %s)", (field, op, value, row, expected) => {
    expect(previewMatches(field, op, value, row), "preview SQL").toBe(expected);
    expect(engineMatches(field, op, value, row), "filter engine").toBe(expected);
  });

  // CHARACTERIZATION(rule-preview-domain-ignores-op): the preview's `domain`
  // branch drops the operator and always builds `%@value%`, so equals and
  // starts_with silently behave as "contains, anchored right after the @".
  it("domain: preview ignores the operator, so equals over-counts and contains under-counts", () => {
    // `equals` — the preview counts a relayed header whose real sender the
    // engine's emailDomain() reads out of the angle brackets as notacme.com.
    const relayed: Row = { from_addr: "billing@acme.com via lists <noreply@notacme.com>" };
    expect(previewMatches("domain", "equals", "acme.com", relayed)).toBe(true);
    expect(engineMatches("domain", "equals", "acme.com", relayed)).toBe(false);

    const embedded: Row = { from_addr: "noreply@acme.com.evil.test" };
    expect(previewMatches("domain", "equals", "acme.com", embedded)).toBe(true);
    expect(engineMatches("domain", "equals", "acme.com", embedded)).toBe(false);

    // `starts_with` — same missing arm, opposite direction.
    const sub: Row = { from_addr: "noreply@mail.acme.com" };
    expect(previewMatches("domain", "starts_with", "acme", sub)).toBe(false);
    expect(engineMatches("domain", "starts_with", "acme", sub)).toBe(false);
    expect(previewMatches("domain", "starts_with", "mail", sub)).toBe(true);
    expect(engineMatches("domain", "starts_with", "mail", sub)).toBe(true);

    // `contains` on a subdomain sender: the engine searches the whole
    // domain, the preview only the run that begins at the "@".
    expect(previewMatches("domain", "contains", "acme.com", sub)).toBe(false);
    expect(engineMatches("domain", "contains", "acme.com", sub)).toBe(true);
  });

  // CHARACTERIZATION(rule-preview-domain-ignores-op): origin_domain shares the
  // `domain` branch's dropped operator.
  it("origin_domain: preview ignores the operator the same way domain does", () => {
    const sub: Row = { from_addr: "x@y.test", origin_addr: "noreply@mail.acme.com" };
    expect(previewMatches("origin_domain", "contains", "acme.com", sub)).toBe(false);
    expect(engineMatches("origin_domain", "contains", "acme.com", sub)).toBe(true);

    const embedded: Row = { from_addr: "x@y.test", origin_addr: "noreply@acme.com.evil.test" };
    expect(previewMatches("origin_domain", "equals", "acme.com", embedded)).toBe(true);
    expect(engineMatches("origin_domain", "equals", "acme.com", embedded)).toBe(false);
  });

  // CHARACTERIZATION(rule-preview-from-equals-is-substring): the preview's
  // `from` branch has no `equals` arm, so an "is exactly" rule is counted as
  // a substring match. The engine's `from` field is `from_addr + " " +
  // from_name`, so its `equals` cannot match a bare address at all — the two
  // sides are wrong in opposite directions and never agree.
  it("from equals: preview counts substrings, the engine can never match at all", () => {
    const exact: Row = { from_addr: "boss@acme.com", from_name: "" };
    expect(previewMatches("from", "equals", "boss@acme.com", exact)).toBe(true);
    // "boss@acme.com " — the engine joins a trailing space even with no name.
    expect(engineMatches("from", "equals", "boss@acme.com", exact)).toBe(false);

    const superstring: Row = { from_addr: "theboss@acme.com.evil.test", from_name: "" };
    expect(previewMatches("from", "equals", "boss@acme.com", superstring)).toBe(true);
    expect(engineMatches("from", "equals", "boss@acme.com", superstring)).toBe(false);
  });

  // CHARACTERIZATION(rule-preview-from-ignores-display-name): the engine's
  // `from` field concatenates the display name, so `from contains "acme"`
  // fires on "Acme Support <noreply@vendor.test>". The preview only ever
  // ILIKEs from_addr, and there is no plaintext from_name column to widen it
  // to — from_name is stored encrypted.
  it("from contains: the engine matches the display name, the preview cannot", () => {
    const named: Row = { from_addr: "noreply@vendor.test", from_name: "Acme Support" };
    expect(engineMatches("from", "contains", "acme", named)).toBe(true);
    expect(previewMatches("from", "contains", "acme", named)).toBe(false);
  });
});

describe("normalizeRuleValue", () => {
  it("lowercases and strips a leading @ for sender/domain fields, preserves subject case", () => {
    expect(normalizeRuleValue("domain", " @Acme.COM ")).toBe("acme.com");
    expect(normalizeRuleValue("from", "Boss@Acme.com")).toBe("boss@acme.com");
    expect(normalizeRuleValue("subject", " Invoice DUE ")).toBe("Invoice DUE");
  });
});

describe("isOriginField", () => {
  it("only origin_from / origin_domain are origin fields", () => {
    expect(isOriginField("origin_from")).toBe(true);
    expect(isOriginField("origin_domain")).toBe(true);
    expect(isOriginField("from")).toBe(false);
    expect(isOriginField("domain")).toBe(false);
    expect(isOriginField("subject")).toBe(false);
  });
});
