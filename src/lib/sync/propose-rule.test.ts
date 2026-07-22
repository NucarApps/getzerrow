// Rule-from-email proposals (rules upgrade, task 11). Contracts:
//
//   * the AI reply is untrusted — anything that fails the strict Zod
//     shape, carries a non-whitelisted action, or exceeds the save
//     path's tree bounds parses to null (caller falls back),
//   * only flag-like actions are proposable — a model can never smuggle
//     a webhook/outbound action through a proposal,
//   * the deterministic fallback always yields a valid domain (or
//     exact-sender) rule.

import { describe, it, expect } from "vitest";
import { parseProposal, buildFallbackProposal } from "./propose-rule";
import { validateRuleNode } from "./filter-engine";

const VALID = {
  suggested_folder_name: "Stripe receipts",
  filter_tree: {
    type: "group",
    op: "or",
    children: [
      { type: "cond", field: "domain", op: "equals", value: "stripe.com" },
      { type: "cond", field: "subject", op: "contains", value: "receipt" },
    ],
  },
  actions: ["archive", "archive", "mark_read"],
};

describe("parseProposal", () => {
  it("accepts a valid reply (even wrapped in prose) and dedupes actions", () => {
    const raw = `Sure! Here is the rule:\n${JSON.stringify(VALID)}\nHope that helps.`;
    const p = parseProposal(raw);
    expect(p).not.toBeNull();
    expect(p!.suggested_folder_name).toBe("Stripe receipts");
    expect(p!.actions).toEqual(["archive", "mark_read"]);
    expect(p!.fallback).toBe(false);
  });

  it.each([
    ["not json at all", "no braces here"],
    ["malformed json", "{ suggested_folder_name: oops"],
    ["missing name", JSON.stringify({ ...VALID, suggested_folder_name: "" })],
    [
      "non-whitelisted action (webhook smuggling)",
      JSON.stringify({ ...VALID, actions: ["call_webhook"] }),
    ],
    [
      "outbound action (send_email smuggling)",
      JSON.stringify({ ...VALID, actions: ["send_email"] }),
    ],
    [
      "bad tree node shape",
      JSON.stringify({ ...VALID, filter_tree: { type: "cond", field: "domain" } }),
    ],
    [
      "oversized leaf value",
      JSON.stringify({
        ...VALID,
        filter_tree: { type: "cond", field: "domain", op: "equals", value: "x".repeat(600) },
      }),
    ],
  ])("rejects %s", (_label, raw) => {
    expect(parseProposal(raw)).toBeNull();
  });

  it("rejects trees deeper than the save path's bounds", () => {
    // 9 nested groups > MAX_FILTER_TREE_DEPTH (8).
    let node: unknown = { type: "cond", field: "from", op: "contains", value: "a" };
    for (let i = 0; i < 9; i++) node = { type: "group", op: "and", children: [node] };
    const raw = JSON.stringify({ ...VALID, filter_tree: node });
    expect(parseProposal(raw)).toBeNull();
  });
});

describe("buildFallbackProposal", () => {
  it("builds a domain rule from the sender address", () => {
    const p = buildFallbackProposal({ from_addr: "billing@Stripe.com", from_name: null });
    expect(p.fallback).toBe(true);
    expect(p.filter_tree).toEqual({
      type: "cond",
      field: "domain",
      op: "equals",
      value: "stripe.com",
    });
    expect(p.suggested_folder_name).toBe("Stripe");
    expect(validateRuleNode(p.filter_tree).ok).toBe(true);
    expect(p.actions).toEqual([]);
  });

  it("falls back to an exact-sender rule when there is no domain", () => {
    const p = buildFallbackProposal({ from_addr: "local-part-only", from_name: "The Printer" });
    expect(p.filter_tree).toEqual({
      type: "cond",
      field: "from",
      op: "equals",
      value: "local-part-only",
    });
    expect(p.suggested_folder_name).toBe("The Printer");
  });
});
