import { describe, expect, it } from "vitest";
import {
  validateOverrideInput,
  type OverrideInput,
  type OverrideValidation,
} from "./inbox-overrides";

function check(over: Partial<OverrideInput> = {}): OverrideValidation {
  return validateOverrideInput({
    raw: "ceo@acme.com",
    matchType: "email",
    accountId: "acc-1",
    ...over,
  });
}

describe("validateOverrideInput — nothing typed", () => {
  it.each([
    ["an empty box", ""],
    ["only spaces", "   "],
    ["only a tab", "\t"],
  ])("does nothing and says nothing for %s", (_label, raw) => {
    // No toast: the user has not asked for anything yet, so complaining at
    // them would be noise.
    expect(check({ raw })).toStrictEqual({ ok: false, reason: "empty", message: null });
  });

  it("checks for an empty box before it checks for an account", () => {
    expect(check({ raw: "  ", accountId: null })).toStrictEqual({
      ok: false,
      reason: "empty",
      message: null,
    });
  });
});

describe("validateOverrideInput — no Gmail account selected", () => {
  it("asks the user to pick an account before anything else is judged", () => {
    expect(check({ accountId: null })).toStrictEqual({
      ok: false,
      reason: "no_account",
      message: "Pick a Gmail account first",
    });
  });

  it("blames the missing account rather than the malformed value", () => {
    expect(check({ accountId: null, raw: "not-an-address" })).toStrictEqual({
      ok: false,
      reason: "no_account",
      message: "Pick a Gmail account first",
    });
  });
});

describe("validateOverrideInput — email entries", () => {
  it("accepts an address", () => {
    expect(check({ raw: "ceo@acme.com" })).toStrictEqual({
      ok: true,
      value: "ceo@acme.com",
      matchType: "email",
    });
  });

  it.each([
    ["a bare domain", "acme.com"],
    ["a local part only", "ceo"],
    ["a URL", "https://acme.com"],
  ])("rejects %s with the full-address message", (_label, raw) => {
    expect(check({ raw })).toStrictEqual({
      ok: false,
      reason: "not_an_email",
      message: "Enter a full email address",
    });
  });

  it("accepts anything with an @ — the check is presence, not shape", () => {
    // Deliberate: address grammar is not re-litigated in the browser. The
    // matcher compares the stored value to the sender address verbatim, so a
    // nonsense entry simply never fires.
    expect(check({ raw: "@" })).toStrictEqual({ ok: true, value: "@", matchType: "email" });
  });
});

describe("validateOverrideInput — domain entries", () => {
  it("accepts a bare domain", () => {
    expect(check({ raw: "acme.com", matchType: "domain" })).toStrictEqual({
      ok: true,
      value: "acme.com",
      matchType: "domain",
    });
  });

  it.each([
    ["a full address", "ceo@acme.com"],
    ["an at-prefixed domain", "@acme.com"],
  ])("rejects %s with the domain-only message", (_label, raw) => {
    expect(check({ raw, matchType: "domain" })).toStrictEqual({
      ok: false,
      reason: "not_a_domain",
      message: "Enter a domain only (e.g. example.com)",
    });
  });

  it("accepts a subdomain", () => {
    expect(check({ raw: "mail.acme.com", matchType: "domain" }).ok).toBe(true);
  });
});

describe("validateOverrideInput — normalisation", () => {
  it("trims the surrounding whitespace an autofill or a paste leaves behind", () => {
    expect(check({ raw: "  ceo@acme.com \n" })).toStrictEqual({
      ok: true,
      value: "ceo@acme.com",
      matchType: "email",
    });
  });

  it("lower-cases the value, because the matcher compares for exact equality", () => {
    // decide-folder compares the stored value to an already-lower-cased
    // sender address, so a stored "CEO@Acme.com" would never match anything.
    expect(check({ raw: "CEO@Acme.COM" })).toStrictEqual({
      ok: true,
      value: "ceo@acme.com",
      matchType: "email",
    });
  });

  it("lower-cases a domain too", () => {
    expect(check({ raw: " ACME.com ", matchType: "domain" })).toStrictEqual({
      ok: true,
      value: "acme.com",
      matchType: "domain",
    });
  });

  it("normalises before it validates, so a padded domain is not read as an address", () => {
    expect(check({ raw: "   acme.com   ", matchType: "domain" }).ok).toBe(true);
  });

  it("keeps whitespace inside the value rather than stripping it", () => {
    // Only the ends are trimmed. An address with an interior space is stored
    // as typed and simply never matches a real sender.
    expect(check({ raw: "ceo @acme.com" })).toStrictEqual({
      ok: true,
      value: "ceo @acme.com",
      matchType: "email",
    });
  });

  it("reports the match type it was given so the caller stores a consistent pair", () => {
    expect(check({ raw: "acme.com", matchType: "domain" })).toMatchObject({ matchType: "domain" });
    expect(check({ raw: "ceo@acme.com", matchType: "email" })).toMatchObject({
      matchType: "email",
    });
  });
});

describe("validateOverrideInput — duplicates", () => {
  // CHARACTERIZATION(inbox-override-duplicate-unguarded): a repeat add is only caught by a unique key that ignores the account — flip when fixed
  it("accepts a value that is already on the list", () => {
    // Nothing here (and nothing in the add handler) looks at the existing
    // rows, so the only guard is the database's UNIQUE (user_id, match_type,
    // value). That key does not include gmail_account_id, so listing the same
    // domain on a second Gmail account is rejected outright, and either way
    // the user is shown the raw Postgres unique-violation text.
    expect(check({ raw: "acme.com", matchType: "domain" })).toStrictEqual({
      ok: true,
      value: "acme.com",
      matchType: "domain",
    });
    expect(check({ raw: "ACME.com ", matchType: "domain" })).toStrictEqual({
      ok: true,
      value: "acme.com",
      matchType: "domain",
    });
  });
});
