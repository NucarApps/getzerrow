import { describe, it, expect } from "vitest";
import { phoneEntrySchema } from "./contacts-helpers.server";

const parse = (number: string) => phoneEntrySchema.safeParse({ label: "mobile", number });
const expectParses = (input: string, expected: string) => {
  const r = parse(input);
  expect(r.success, `expected "${input}" to parse`).toBe(true);
  if (r.success) expect(r.data.number).toBe(expected);
};
const expectRejects = (input: string) => {
  expect(parse(input).success, `expected "${input}" to reject`).toBe(false);
};

describe("phoneEntrySchema.number normalization", () => {
  describe("whitespace handling", () => {
    it("trims leading and trailing whitespace", () => {
      expectParses("  415-555-0100  ", "415-555-0100");
    });

    it("collapses runs of spaces", () => {
      expectParses("415   555   0100", "415 555 0100");
    });

    it("collapses NBSP, tabs, and mixed whitespace", () => {
      expectParses("555\u00A0123\t4567", "555 123 4567");
      expectParses("+1\t415\u00A0555 0100", "+1 415 555 0100");
    });

    it("collapses newlines and carriage returns", () => {
      expectParses("415-555-0100\n\r ext 42", "415-555-0100 ext 42");
    });
  });

  describe("extension separators", () => {
    it("preserves ;", () => {
      expectParses("  800-225-1865 ;7160 ", "800-225-1865 ;7160");
    });

    it("preserves , (Android pause) including repeated", () => {
      expectParses("+1 (415) 555-0100,,,123", "+1 (415) 555-0100,,,123");
    });

    it("preserves * (DTMF)", () => {
      expectParses("+1-800-555-0100*7", "+1-800-555-0100*7");
    });

    it("preserves # (DTMF)", () => {
      expectParses("+1-800-555-0100#42", "+1-800-555-0100#42");
    });

    it("preserves : and mixed separators", () => {
      expectParses("415-555-0100:1234", "415-555-0100:1234");
      expectParses("415-555-0100 ;,*#123", "415-555-0100 ;,*#123");
    });

    it("preserves x / X / ext letter forms", () => {
      expectParses("415-555-0100 x1234", "415-555-0100 x1234");
      expectParses("415-555-0100 X1234", "415-555-0100 X1234");
      expectParses("415-555-0100 ext 1234", "415-555-0100 ext 1234");
      expectParses("415.555.0100 ext.99", "415.555.0100 ext.99");
    });
  });

  describe("international formats", () => {
    it("keeps +, spaces, parens, and dashes", () => {
      expectParses("+44 20 7946 0018", "+44 20 7946 0018");
      expectParses("+49 (0)30 12345678", "+49 (0)30 12345678");
      expectParses("+1 (415) 555-0100", "+1 (415) 555-0100");
    });

    it("keeps dotted format", () => {
      expectParses("415.555.0100", "415.555.0100");
    });

    it("keeps slash separator (common in DE/AT)", () => {
      expectParses("030/12345678", "030/12345678");
    });
  });

  describe("rejections", () => {
    it("rejects letters outside x/X/ext-ish characters — emoji", () => {
      expectRejects("555-hello😀");
    });

    it("rejects too-short input", () => {
      expectRejects("12");
      expectRejects("  1 ");
    });

    it("rejects empty and whitespace-only", () => {
      expectRejects("");
      expectRejects("     ");
      expectRejects("\t\n");
    });

    it("rejects overly long input (>60 after normalization)", () => {
      expectRejects("+1 " + "5".repeat(80));
    });

    it("rejects disallowed punctuation", () => {
      expectRejects("415_555_0100");
      expectRejects("415!555!0100");
      expectRejects("415<555>0100");
    });
  });
});
