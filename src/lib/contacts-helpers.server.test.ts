// Unit tests for the shared contact helpers (src/lib/contacts-helpers.server.ts).
// These are small pure functions, but every contact the app creates from mail
// passes through them: `isLikelyHuman` decides whether a sender becomes a
// contact at all, `normalizeName` / `pickBetterName` decide what it is called
// and whether a later, worse name is allowed to overwrite a better one, and
// the phone/email schemas are the server's last word on what may be stored.
//
// The phone table also serves as a parity check against
// `contacts/phone.ts:validatePhoneNumber`, the client mirror the form uses to
// show a verdict before the round-trip: the two must never disagree, or the
// UI accepts something the server then refuses (or vice versa).

import { describe, it, expect, vi, beforeEach } from "vitest";

const listMessages =
  vi.fn<(accountId: string, opts: unknown) => Promise<{ messages?: Array<{ id: string }> }>>();
const getMessage = vi.fn<(accountId: string, id: string) => Promise<{ id: string }>>();
const parseMessage = vi.fn<(raw: { id: string }) => { gmail_message_id: string }>();
vi.mock("./gmail.server", () => ({
  listMessages: (accountId: string, opts: unknown) => listMessages(accountId, opts),
  getMessage: (accountId: string, id: string) => getMessage(accountId, id),
  parseMessage: (raw: { id: string }) => parseMessage(raw),
}));

import {
  isLikelyHuman,
  normalizeName,
  firstNameKey,
  pickBetterName,
  phoneEntrySchema,
  emailEntrySchema,
  fetchFromGmail,
} from "./contacts-helpers.server";
import { validatePhoneNumber } from "./contacts/phone";

describe("isLikelyHuman", () => {
  it.each([
    ["a personal address", "jane@acme.com", true],
    ["a mixed-case address with padding", "  Jane@Acme.com ", true],
    ["a domain that merely contains a banned word", "jane@nohello.com", true],
    ["a no-reply sender", "no-reply@acme.com", false],
    ["a role address", "support@acme.com", false],
    ["a bounce address", "mailer-daemon@acme.com", false],
    ["a string with no @ at all", "jane", false],
    ["a missing address", null, false],
  ])("%s → %s", (_label, addr, expected) => {
    expect(isLikelyHuman(addr)).toBe(expected);
  });

  // CHARACTERIZATION(role-address-filter-matches-substrings): the banned-word
  // check is `local.includes(word)`, not a token match, so a real person whose
  // local part merely contains one of the words is silently never turned into
  // a contact — flip when fixed.
  it("rejects a real person whose local part merely contains a banned word", () => {
    expect(isLikelyHuman("othello@acme.com")).toBe(false);
    expect(isLikelyHuman("s.helpman@acme.com")).toBe(false);
  });
});

describe("normalizeName", () => {
  it.each([
    ["strips surrounding quotes", '"Jane Doe"', "Jane Doe"],
    ["collapses runs of whitespace", "  Jane   Doe  ", "Jane Doe"],
    ["drops a trailing parenthetical", "Jane Doe (via Acme)", "Jane Doe"],
    ["drops a trailing bracketed tag", "Jane Doe [External]", "Jane Doe"],
    ["swaps a single 'Last, First'", "Doe, Jane", "Jane Doe"],
    ["keeps the middle name in the swap", "Doe, Jane Marie", "Jane Marie Doe"],
    ["handles accents and apostrophes in the swap", "O'Brien, Seán", "Seán O'Brien"],
    ["leaves a multi-comma string alone", "Smith, Jones, Bob", "Smith, Jones, Bob"],
    ["title-cases an all-caps name", "JANE DOE", "Jane Doe"],
    ["title-cases an all-lowercase name", "jane doe", "Jane Doe"],
    ["title-cases each half of a hyphenated name", "jean-luc picard", "Jean-Luc Picard"],
    ["leaves mixed case alone", "McDonald", "McDonald"],
    ["leaves an already-normal name alone", "Dr. Jane Doe", "Dr. Jane Doe"],
    ["rejects an email address", "jane@example.com", null],
    ["rejects an angle-bracketed address", "<jane@example.com>", null],
    ["rejects a value that is only a parenthetical", "(via Acme)", null],
    ["rejects an empty value", "", null],
    ["rejects whitespace only", "   ", null],
    ["rejects a missing value", null, null],
  ])("%s", (_label, input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it("strips only the last trailing parenthetical", () => {
    expect(normalizeName("Jane Doe (Sales) (Acme)")).toBe("Jane Doe (Sales)");
  });

  it("accepts a local-part-only address, because the reject needs a TLD", () => {
    // Guards the shape of the reject: it is "looks like an email address",
    // not "contains an @".
    expect(normalizeName("jane@x")).toBe("Jane@x");
  });

  it("applies the 'Last, First' swap to a company name too", () => {
    // Worth knowing before reusing this on anything but a person's name.
    expect(normalizeName("Acme, Inc.")).toBe("Inc. Acme");
  });
});

describe("firstNameKey", () => {
  it.each([
    ["uses the first token of the normalized name", "Doe, Jane", "x@y.com", "jane"],
    ["falls back to the email local part", null, "Jane.Doe@Y.com", "jane.doe"],
    ["falls back when the name is empty", "", "bob@y.com", "bob"],
    ["falls back when the name is really an address", "jane@x.com", "fallback@y.com", "fallback"],
  ])("%s", (_label, name, email, expected) => {
    expect(firstNameKey(name, email)).toBe(expected);
  });
});

describe("pickBetterName", () => {
  it.each([
    ["never truncates to a prefix of itself", "Jane Doe", "Jane", "Jane Doe"],
    ["accepts an extension of what it has", "Jane", "Jane Doe", "Jane Doe"],
    ["accepts a longer unrelated name", "Jane Doe", "Jane Marie Doe", "Jane Marie Doe"],
    ["prefers the candidate on a tie", "Jane Doe", "Bob Smith", "Bob Smith"],
    ["normalizes whichever it returns", null, "jane doe", "Jane Doe"],
    ["keeps the existing name when the candidate is missing", "Jane Doe", null, "Jane Doe"],
    ["returns null when neither side has a usable name", null, "jane@x.com", null],
  ])("%s", (_label, existing, candidate, expected) => {
    expect(pickBetterName(existing, candidate)).toBe(expected);
  });

  it("keeps the existing casing when the candidate is the same name shouted", () => {
    // Both normalize to "Jane Doe"; same token count, so the candidate wins —
    // but normalization means the shouting never reaches the database.
    expect(pickBetterName("Jane Doe", "JANE DOE")).toBe("Jane Doe");
  });
});

// ── Phone entry schema ────────────────────────────────────────────────────
// Cases are shared with the client mirror below; each row is
// [input, expected normalized form] or [input, null] to mean "rejected".
const PHONE_CASES: Array<[string, string | null]> = [
  // whitespace
  ["  415-555-0100  ", "415-555-0100"],
  ["415   555   0100", "415 555 0100"],
  ["555 123\t4567", "555 123 4567"],
  ["+1\t415 555 0100", "+1 415 555 0100"],
  ["415-555-0100\n\r ext 42", "415-555-0100 ext 42"],
  // extension separators
  ["  800-225-1865 ;7160 ", "800-225-1865 ;7160"],
  ["+1 (415) 555-0100,,,123", "+1 (415) 555-0100,,,123"],
  ["+1-800-555-0100*7", "+1-800-555-0100*7"],
  ["+1-800-555-0100#42", "+1-800-555-0100#42"],
  ["415-555-0100:1234", "415-555-0100:1234"],
  ["415-555-0100 ;,*#123", "415-555-0100 ;,*#123"],
  ["415-555-0100 x1234", "415-555-0100 x1234"],
  ["415-555-0100 X1234", "415-555-0100 X1234"],
  ["415-555-0100 ext 1234", "415-555-0100 ext 1234"],
  ["415.555.0100 ext.99", "415.555.0100 ext.99"],
  // international formats
  ["+44 20 7946 0018", "+44 20 7946 0018"],
  ["+49 (0)30 12345678", "+49 (0)30 12345678"],
  ["+1 (415) 555-0100", "+1 (415) 555-0100"],
  ["415.555.0100", "415.555.0100"],
  ["030/12345678", "030/12345678"],
  // rejections
  ["555-hello😀", null],
  ["12", null],
  ["  1 ", null],
  ["", null],
  ["     ", null],
  ["\t\n", null],
  [`+1 ${"5".repeat(80)}`, null],
  ["415_555_0100", null],
  ["415!555!0100", null],
  ["415<555>0100", null],
];

describe("phoneEntrySchema", () => {
  it.each(PHONE_CASES)("%j normalizes to %j", (input, expected) => {
    const result = phoneEntrySchema.safeParse({ label: "mobile", number: input });
    expect(result.success).toBe(expected !== null);
    if (result.success) expect(result.data.number).toBe(expected);
  });

  it("requires a label of 1-20 characters", () => {
    expect(phoneEntrySchema.safeParse({ label: "  ", number: "415-555-0100" }).success).toBe(false);
    expect(
      phoneEntrySchema.safeParse({ label: "x".repeat(21), number: "415-555-0100" }).success,
    ).toBe(false);
    expect(phoneEntrySchema.safeParse({ label: " mobile ", number: "415-555-0100" })).toMatchObject(
      { success: true, data: { label: "mobile" } },
    );
  });

  it("carries the primary flag through when given", () => {
    expect(
      phoneEntrySchema.parse({ label: "mobile", number: "415-555-0100", is_primary: true }),
    ).toStrictEqual({ label: "mobile", number: "415-555-0100", is_primary: true });
  });
});

describe("validatePhoneNumber parity with phoneEntrySchema", () => {
  // The client mirror exists so the form can answer inline. If the two ever
  // disagree the user is told one thing and the server does another.
  it.each(PHONE_CASES)("%j gets the same verdict on both sides", (input, expected) => {
    const client = validatePhoneNumber(input);
    const server = phoneEntrySchema.safeParse({ label: "mobile", number: input });

    expect(client.ok).toBe(server.success);
    if (client.ok && server.success) {
      expect(client.normalized).toBe(server.data.number);
      expect(client.normalized).toBe(expected);
    }
  });

  it("names the offending character when it can find one", () => {
    expect(validatePhoneNumber("415_555_0100")).toStrictEqual({
      ok: false,
      normalized: "415_555_0100",
      reason: '"_" isn\'t a valid phone character',
    });
  });

  it("explains a length rejection rather than blaming a character", () => {
    expect(validatePhoneNumber("12")).toMatchObject({
      ok: false,
      reason: "Phone must be at least 3 characters",
    });
    expect(validatePhoneNumber(`+1 ${"5".repeat(80)}`)).toMatchObject({
      ok: false,
      reason: "Phone must be 60 characters or fewer",
    });
  });
});

describe("emailEntrySchema", () => {
  it("trims and lowercases the address", () => {
    expect(emailEntrySchema.parse({ label: "work", address: "  Jane@Acme.COM " })).toStrictEqual({
      label: "work",
      address: "jane@acme.com",
    });
  });

  it.each([
    ["a non-address", "not-an-email"],
    ["an address with no domain", "jane@"],
    ["an empty value", ""],
  ])("rejects %s", (_label, address) => {
    expect(emailEntrySchema.safeParse({ label: "work", address }).success).toBe(false);
  });
});

describe("fetchFromGmail", () => {
  beforeEach(() => {
    listMessages.mockResolvedValue({ messages: [] });
    getMessage.mockImplementation(async (_acct, id) => ({ id }));
    parseMessage.mockImplementation((raw) => ({ gmail_message_id: raw.id }));
  });

  it("returns the first account that yields any messages, and stops there", async () => {
    listMessages.mockImplementation(async (accountId) =>
      accountId === "acct-2" ? { messages: [{ id: "m1" }, { id: "m2" }] } : { messages: [] },
    );

    const out = await fetchFromGmail(["acct-1", "acct-2", "acct-3"], "from:acme.com", 25);

    expect(out).toStrictEqual([{ gmail_message_id: "m1" }, { gmail_message_id: "m2" }]);
    expect(listMessages.mock.calls.map((c) => c[0])).toStrictEqual(["acct-1", "acct-2"]);
    expect(listMessages).toHaveBeenCalledWith("acct-2", { q: "from:acme.com", maxResults: 25 });
  });

  it("moves on to the next account when one account's list fails", async () => {
    listMessages.mockImplementation(async (accountId) => {
      if (accountId === "acct-1") throw new Error("invalid_grant");
      return { messages: [{ id: "m1" }] };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const out = await fetchFromGmail(["acct-1", "acct-2"], "q", 5);

    expect(out).toStrictEqual([{ gmail_message_id: "m1" }]);
  });

  it("skips a single unreadable message rather than losing the batch", async () => {
    listMessages.mockResolvedValue({ messages: [{ id: "bad" }, { id: "good" }] });
    getMessage.mockImplementation(async (_acct, id) => {
      if (id === "bad") throw new Error("404");
      return { id };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await fetchFromGmail(["acct-1"], "q", 5)).toStrictEqual([{ gmail_message_id: "good" }]);
  });

  it("returns an empty list when no account has anything", async () => {
    expect(await fetchFromGmail(["acct-1", "acct-2"], "q", 5)).toStrictEqual([]);
    expect(getMessage).not.toHaveBeenCalled();
  });
});
