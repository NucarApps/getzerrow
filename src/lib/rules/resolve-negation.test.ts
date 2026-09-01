import { describe, it, expect } from "vitest";
import { evaluateRule } from "./resolve";
import type { EngineMessage, Rule } from "./types";

const msg = (subject: string, from = "billing@acme.com"): EngineMessage =>
  ({
    id: "m1",
    from_addr: from,
    from_name: "",
    subject,
    snippet: "",
    to: "",
    cc: "",
    reply_to: "",
    list_id: "",
    has_attachment: false,
    is_reply: false,
  }) as unknown as EngineMessage;

const rule = (op: string, value: string, field = "subject"): Rule => ({
  id: "r1",
  folder_id: "f1",
  created_at: "2020-01-01T00:00:00Z",
  groups: [[{ field, op, value }]],
});

describe("negative operators inside a rule", () => {
  it("not_contains matches only messages WITHOUT the value", () => {
    expect(evaluateRule(rule("not_contains", "invoice"), msg("Your receipt")).matched).toBe(true);
    expect(evaluateRule(rule("not_contains", "invoice"), msg("Invoice 12")).matched).toBe(false);
  });
  it("not_equals matches only messages that differ", () => {
    expect(evaluateRule(rule("not_equals", "hello"), msg("world")).matched).toBe(true);
    expect(evaluateRule(rule("not_equals", "hello"), msg("hello")).matched).toBe(false);
  });
  it("domain_in matches when the sender domain IS listed", () => {
    const r = rule("domain_in", "acme.com, foo.com", "domain");
    expect(evaluateRule(r, msg("hi", "a@acme.com")).matched).toBe(true);
    expect(evaluateRule(r, msg("hi", "a@other.com")).matched).toBe(false);
  });
});
