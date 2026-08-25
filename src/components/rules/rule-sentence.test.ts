import { describe, expect, it } from "vitest";
import {
  conditionSentence,
  draftLevel,
  fieldLabel,
  isBooleanField,
  opLabel,
  parseConditionInput,
} from "./rule-sentence";

describe("rule sentence labels", () => {
  it("reads fields and operators as plain language", () => {
    expect(fieldLabel("origin_from")).toBe("the original sender (before forwarding)");
    expect(fieldLabel("unknown_field")).toBe("unknown_field");
    expect(opLabel("domain_in")).toBe("is one of");
    expect(isBooleanField("has_attachment")).toBe(true);
    expect(isBooleanField("subject")).toBe(false);
  });

  it("writes a condition as a sentence fragment", () => {
    expect(conditionSentence({ field: "from", op: "contains", value: "a@b.com" })).toBe(
      'the sender contains "a@b.com"',
    );
    expect(conditionSentence({ field: "has_attachment", op: "equals", value: "false" })).toBe(
      "the message has an attachment is no",
    );
  });
});

describe("parseConditionInput", () => {
  it("reads a full address as an exact-sender condition (L1)", () => {
    const c = parseConditionInput(" Billing@Netflix.com ");
    expect(c).toEqual({ field: "from", op: "contains", value: "billing@netflix.com" });
    expect(draftLevel([[c]])).toBe(1);
  });

  it("reads a bare or @-prefixed domain as an exact-domain condition (L2)", () => {
    expect(parseConditionInput("@acme.com")).toEqual({
      field: "domain",
      op: "equals",
      value: "acme.com",
    });
    expect(draftLevel([[parseConditionInput("acme.com")]])).toBe(2);
  });

  it("falls back to a subject phrase (L5)", () => {
    const c = parseConditionInput("quarterly report");
    expect(c).toEqual({ field: "subject", op: "contains", value: "quarterly report" });
    expect(draftLevel([[c]])).toBe(5);
  });

  it("takes the most specific condition across groups", () => {
    expect(
      draftLevel([
        [{ field: "subject", op: "contains", value: "invoice" }],
        [{ field: "from", op: "contains", value: "a@b.com" }],
      ]),
    ).toBe(1);
  });
});
