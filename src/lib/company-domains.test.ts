import { describe, it, expect } from "vitest";
import { emailDomain, isRoutableDomain } from "./company-domains";

// emailDomain is the single source of truth for every domain-keyed routing
// decision (folder-rule `domain` conditions, `domain_in` allowlists, inbox
// overrides). Before it existed, producers used one of three `extractDomain`
// variants while consumers used an inline `split("@")[1]`, so a rule stored
// from a malformed sender could never match the domain later computed for that
// same sender — and it failed silently.

describe("emailDomain", () => {
  it("extracts from a bare address", () => {
    expect(emailDomain("jane@acme.com")).toBe("acme.com");
  });

  it("lowercases and trims", () => {
    expect(emailDomain("  JANE@ACME.COM  ")).toBe("acme.com");
  });

  it("extracts from the standard `Name <addr>` form", () => {
    expect(emailDomain("Jane Doe <jane@acme.com>")).toBe("acme.com");
    expect(emailDomain("<jane@acme.com>")).toBe("acme.com");
  });

  // The shapes that defeated the old anchored From parser and so were stored
  // verbatim in emails.from_addr. These are the actual bug.
  describe("headers that were stored unnormalized", () => {
    it("handles an inner-quoted display name", () => {
      expect(emailDomain('Jane "JD" Doe <jane@acme.com>')).toBe("acme.com");
    });

    it("handles a trailing comment after the address", () => {
      expect(emailDomain("Jane <jane@acme.com> (Sales)")).toBe("acme.com");
    });

    it("takes the first address from a multi-address value", () => {
      expect(emailDomain("Jane Doe <a@acme.com>, Bob <b@other.com>")).toBe("acme.com");
    });

    it("handles an RFC 2047 encoded display name", () => {
      expect(emailDomain("=?UTF-8?Q?Jan=C3=A9?= <jane@acme.com>")).toBe("acme.com");
    });

    it("strips a stray trailing angle bracket from a partial parse", () => {
      expect(emailDomain("jane@acme.com>")).toBe("acme.com");
    });
  });

  it("uses the LAST @ so a local-part containing @ can't shift the domain", () => {
    expect(emailDomain("a@b@acme.com")).toBe("acme.com");
  });

  it("keeps subdomains intact", () => {
    expect(emailDomain("no-reply@mail.acme.co.uk")).toBe("mail.acme.co.uk");
  });

  it("does NOT require a dot — that check lives in isRoutableDomain", () => {
    expect(emailDomain("user@localhost")).toBe("localhost");
  });

  it("returns null when there is no parseable @domain", () => {
    expect(emailDomain("notanemail")).toBeNull();
    expect(emailDomain("acme.com> (sales)")).toBeNull();
    expect(emailDomain("")).toBeNull();
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
  });

  // The regression that motivated all of this: the value an override is WRITTEN
  // with must equal the value the classifier later COMPUTES for the same
  // sender. One helper for both sides is what guarantees it.
  it("is stable between writer and reader for every malformed shape", () => {
    const senders = [
      "jane@acme.com",
      "Jane Doe <jane@acme.com>",
      'Jane "JD" Doe <jane@acme.com>',
      "Jane <jane@acme.com> (Sales)",
      "Jane Doe <a@acme.com>, Bob <b@other.com>",
      "jane@acme.com>",
    ];
    for (const s of senders) {
      // writer side (gmail/move.functions) and reader side (sync/classify)
      expect(emailDomain(s)).toBe(emailDomain(s));
      expect(emailDomain(s)).toBe("acme.com");
    }
  });
});

describe("isRoutableDomain", () => {
  it("accepts real domains", () => {
    expect(isRoutableDomain("acme.com")).toBe(true);
    expect(isRoutableDomain("mail.acme.co.uk")).toBe(true);
    expect(isRoutableDomain("my-company.io")).toBe(true);
  });

  it("rejects dotless hosts", () => {
    expect(isRoutableDomain("localhost")).toBe(false);
    expect(isRoutableDomain("intranet")).toBe(false);
  });

  it("rejects empty and nullish input", () => {
    expect(isRoutableDomain("")).toBe(false);
    expect(isRoutableDomain(null)).toBe(false);
    expect(isRoutableDomain(undefined)).toBe(false);
  });

  it("rejects a value that still carries address punctuation", () => {
    expect(isRoutableDomain("acme.com>")).toBe(false);
    expect(isRoutableDomain("acme.com (sales)")).toBe(false);
  });
});
