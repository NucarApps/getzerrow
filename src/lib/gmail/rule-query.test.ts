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
    // Characterization: `equals` on from falls into the same %…% shape as
    // contains (the `pat` branch has no equals arm) — preview and backfill
    // share this exact behavior, which is the invariant that matters.
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

  it("preview and backfill produce byte-identical predicates for the same rule", () => {
    // rules.functions.ts routes BOTH the live count (:320) and the
    // apply-to-past backfill (:374) through applySimpleRulePredicate.
    // Two invocations with the same rule must record the same calls —
    // this is the "count and backfill can never disagree" invariant at
    // the unit level (the row-level agreement runs against the real
    // Postgres in the integration suite).
    const rules: Array<[SimpleRuleField, SimpleRuleOp, string]> = [
      ["from", "contains", "a@b.c"],
      ["domain", "equals", "b.c"],
      ["subject", "starts_with", "Re: 100%"],
      ["origin_from", "contains", "x@y.z"],
      ["origin_domain", "contains", "y.z"],
    ];
    for (const [field, op, value] of rules) {
      expect(predicateFor(field, op, value)).toEqual(predicateFor(field, op, value));
    }
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
