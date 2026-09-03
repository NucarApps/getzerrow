// buildVCard and renderCardEmailHtml — everything a stranger receives when
// somebody sends them a card.
//
// Both outputs leave the product: the vCard is imported into the recipient's
// address book, and the HTML is delivered to a third party's mailbox. Every
// field they interpolate is user-controlled (a card's own owner types them,
// and a shared contact's fields can come from a scanned image), so escaping
// is a security contract here, not formatting.
import { describe, expect, it } from "vitest";
import { buildVCard, renderCardEmailHtml, type CardData } from "./cards.server";

function card(over: Partial<CardData> = {}): CardData {
  return {
    handle: "jane",
    name: null,
    title: null,
    company: null,
    email: null,
    phone: null,
    website: null,
    linkedin: null,
    twitter: null,
    tagline: null,
    ...over,
  };
}

/** The vCard as a list of logical lines, so a test can name the one it means. */
function lines(vcf: string): string[] {
  return vcf.split("\r\n");
}
function line(vcf: string, prefix: string): string | undefined {
  return lines(vcf).find((l) => l.startsWith(prefix));
}

describe("buildVCard", () => {
  it("emits a CRLF-joined 3.0 card with only the fields that are set", () => {
    expect(lines(buildVCard(card({ email: "jane@acme.test" })))).toStrictEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:jane@acme.test",
      "EMAIL;TYPE=INTERNET:jane@acme.test",
      "END:VCARD",
    ]);
  });

  it("falls back to the handle for FN when there is no name or email", () => {
    expect(line(buildVCard(card()), "FN:")).toBe("FN:jane");
  });

  it("carries every populated field, the address and the public link", () => {
    const vcf = buildVCard(
      card({
        name: "Jane Doe",
        title: "CTO",
        company: "Acme",
        email: "jane@acme.test",
        phone: "+1 555 0100",
        website: "https://acme.test",
        linkedin: "https://linkedin.test/jane",
        twitter: "https://x.test/jane",
        tagline: "We build things",
        address_line1: "1 Main St",
        address_line2: "Suite 4",
        city: "Springfield",
        region: "IL",
        postal_code: "62704",
        country: "US",
      }),
      "https://atzro.test/c/jane",
    );
    expect(lines(vcf)).toStrictEqual([
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Jane Doe",
      "N:Doe;Jane;;;",
      "TITLE:CTO",
      "ORG:Acme",
      "EMAIL;TYPE=INTERNET:jane@acme.test",
      "TEL;TYPE=CELL:+1 555 0100",
      "URL:https://acme.test",
      "URL;TYPE=LinkedIn:https://linkedin.test/jane",
      "URL;TYPE=Twitter:https://x.test/jane",
      "NOTE:We build things",
      "ADR;TYPE=WORK:;;1 Main St\\, Suite 4;Springfield;IL;62704;US",
      "URL;TYPE=Atzro:https://atzro.test/c/jane",
      "END:VCARD",
    ]);
  });

  describe("the N: split", () => {
    it("puts the last whitespace-separated word in the family slot", () => {
      expect(line(buildVCard(card({ name: "Jane Doe" })), "N:")).toBe("N:Doe;Jane;;;");
    });

    it("keeps every earlier word in the given slot", () => {
      expect(line(buildVCard(card({ name: "Ada  Byron   King" })), "N:")).toBe(
        "N:King;Ada Byron;;;",
      );
    });

    it("treats a single word as the given name, leaving the family slot empty", () => {
      expect(line(buildVCard(card({ name: "Cher" })), "N:")).toBe("N:;Cher;;;");
    });

    it("omits N: entirely when there is no name", () => {
      expect(line(buildVCard(card({ email: "a@b.test" })), "N:")).toBeUndefined();
    });
  });

  describe("value escaping", () => {
    it("escapes a semicolon so it cannot open a new structured field", () => {
      // Unescaped, "Acme; Inc" would shift every following ADR component.
      expect(line(buildVCard(card({ company: "Acme; Inc" })), "ORG:")).toBe("ORG:Acme\\; Inc");
    });

    it("escapes a comma so it cannot split a value list", () => {
      expect(line(buildVCard(card({ company: "Acme, Inc" })), "ORG:")).toBe("ORG:Acme\\, Inc");
    });

    it("escapes a backslash before anything else, so an escape cannot be forged", () => {
      // "a\;b" must not read back as an escaped semicolon.
      expect(line(buildVCard(card({ company: "a\\;b" })), "ORG:")).toBe("ORG:a\\\\\\;b");
    });

    it("folds a newline into the literal \\n a vCard value uses", () => {
      expect(line(buildVCard(card({ tagline: "one\ntwo" })), "NOTE:")).toBe("NOTE:one\\ntwo");
    });

    it("escapes the same characters inside the ADR components", () => {
      const vcf = buildVCard(card({ address_line1: "1 Main St; Rear", city: "Springfield, IL" }));
      expect(line(vcf, "ADR")).toBe("ADR;TYPE=WORK:;;1 Main St\\; Rear;Springfield\\, IL;;;");
    });

    // CHARACTERIZATION(vcard-esc-leaves-carriage-return): esc() folds \n but
    // leaves a bare \r in the value, so a CR the user typed is emitted raw
    // into a CRLF-delimited format.
    it("leaves a carriage return in the value unescaped", () => {
      const vcf = buildVCard(card({ tagline: "one\r\ntwo" }));
      expect(line(vcf, "NOTE:")).toBe("NOTE:one\r\\ntwo");
      // What it should be, once esc() handles \r:
      expect(line(vcf, "NOTE:")).not.toBe("NOTE:one\\ntwo");
    });
  });

  it("omits the ADR line entirely when no address component is set", () => {
    expect(line(buildVCard(card({ name: "Jane Doe" })), "ADR")).toBeUndefined();
  });

  it("emits an ADR line when only the country is known", () => {
    expect(line(buildVCard(card({ country: "US" })), "ADR")).toBe("ADR;TYPE=WORK:;;;;;;US");
  });
});

type EmailCardInput = Parameters<typeof renderCardEmailHtml>[0];
type EmailCard = EmailCardInput["card"];

describe("renderCardEmailHtml", () => {
  const base: EmailCardInput = {
    card: {
      name: "Jane Doe",
      title: "CTO",
      company: "Acme",
      email: "jane@acme.test",
      phone: "+1 (555) 0100",
      website: "https://acme.test",
    },
    attachmentNote: "A .vcf file is attached.",
    footerNote: "Sent with Atzro",
  };

  it("uses the named theme's colours", () => {
    const html = renderCardEmailHtml({ ...base, card: { ...base.card, theme: "sunset" } });
    expect(html).toContain("#f97316");
    expect(html).not.toContain("#6366f1");
  });

  it("falls back to the default theme for an unknown id", () => {
    const html = renderCardEmailHtml({ ...base, card: { ...base.card, theme: "vaporwave" } });
    expect(html).toContain("#6366f1");
  });

  it("falls back to the default theme when no theme is set", () => {
    expect(renderCardEmailHtml(base)).toContain("#6366f1");
  });

  describe("the initials avatar", () => {
    const initials = (over: Partial<EmailCard>) => {
      const html = renderCardEmailHtml({ ...base, card: { ...base.card, ...over } });
      return /width="88" height="88"[^>]*>([^<]*)</.exec(html)?.[1];
    };

    it("takes the first and last words' initials", () => {
      expect(initials({ name: "Jane Doe" })).toBe("JD");
      expect(initials({ name: "Ada Byron King" })).toBe("AK");
    });

    it("takes two letters from a single-word name", () => {
      expect(initials({ name: "Cher" })).toBe("CH");
    });

    it("falls back to the email address when there is no name", () => {
      expect(initials({ name: null })).toBe("JA");
    });

    it("renders a question mark when there is neither", () => {
      expect(initials({ name: null, email: null })).toBe("?");
    });

    it("uses the uploaded avatar instead when one is set", () => {
      const html = renderCardEmailHtml({
        ...base,
        card: { ...base.card, avatar_url: "https://cdn.test/a.png" },
      });
      expect(html).toContain('<img src="https://cdn.test/a.png"');
    });
  });

  describe("escaping — this HTML is delivered to a third party's mailbox", () => {
    const XSS = "<script>alert(1)</script>";

    it.each([
      ["name", "name"],
      ["title", "title"],
      ["company", "company"],
      ["email", "email"],
      ["phone", "phone"],
      ["website", "website"],
      ["tagline", "tagline"],
    ] as const)("escapes markup in %s", (_label, field) => {
      const html = renderCardEmailHtml({
        ...base,
        card: { ...base.card, [field]: XSS },
      });
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("escapes markup in the avatar URL, the intro, the notes and the button", () => {
      const html = renderCardEmailHtml({
        ...base,
        card: { ...base.card, avatar_url: `https://cdn.test/a.png"${XSS}` },
        intro: `hello${XSS}`,
        cta: { url: `https://atzro.test/c/x"${XSS}`, label: XSS },
        attachmentNote: XSS,
        footerNote: XSS,
      });
      expect(html).not.toContain("<script>");
    });

    it("escapes markup in an address line", () => {
      const html = renderCardEmailHtml({ ...base, addressLines: [XSS] });
      expect(html).not.toContain("<script>");
    });
  });

  it("turns newlines in the intro into line breaks", () => {
    const html = renderCardEmailHtml({ ...base, intro: "Hi,\n\nHere's my card." });
    expect(html).toContain("Hi,<br><br>Here&#39;s my card.");
  });

  it("omits the intro block for a blank intro", () => {
    expect(renderCardEmailHtml({ ...base, intro: "   " })).not.toContain("<br>");
  });

  it("renders the call-to-action button only when one is given", () => {
    expect(
      renderCardEmailHtml({ ...base, cta: { url: "https://atzro.test/c/jane", label: "Save" } }),
    ).toContain(">Save</a>");
    expect(renderCardEmailHtml(base)).not.toContain("</a></td></tr></table>");
  });

  it("shows a row per contact channel and none for the fields left empty", () => {
    const html = renderCardEmailHtml({
      ...base,
      card: { ...base.card, linkedin: null, twitter: null },
    });
    expect(html).toContain('href="mailto:jane@acme.test"');
    // The tel: href keeps digits and a leading + only.
    expect(html).toContain('href="tel:+15550100"');
    expect(html).toContain('href="https://acme.test"');
    expect(html).not.toContain(">LinkedIn</a>");
    expect(html).not.toContain(">Twitter / X</a>");
  });

  it("names the card by email, then by 'Contact', when there is no name", () => {
    expect(renderCardEmailHtml({ ...base, card: { ...base.card, name: null } })).toContain(
      ">jane@acme.test</p>",
    );
    expect(
      renderCardEmailHtml({ ...base, card: { ...base.card, name: null, email: null } }),
    ).toContain(">Contact</p>");
  });

  it("joins title and company into one subtitle, or shows whichever is set", () => {
    expect(renderCardEmailHtml(base)).toContain("CTO &middot; Acme");
    expect(renderCardEmailHtml({ ...base, card: { ...base.card, company: null } })).toContain(
      ">CTO</p>",
    );
    expect(renderCardEmailHtml({ ...base, card: { ...base.card, title: null } })).toContain(
      ">Acme</p>",
    );
  });
});
