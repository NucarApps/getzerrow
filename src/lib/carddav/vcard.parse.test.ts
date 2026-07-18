import { describe, it, expect } from "vitest";
import { parseVCard } from "./vcard";

const IOS_VCARD =
  "BEGIN:VCARD\r\n" +
  "VERSION:3.0\r\n" +
  "PRODID:-//Apple Inc.//iOS 17//EN\r\n" +
  "UID:11111111-2222-3333-4444-555555555555\r\n" +
  "FN:Jane Doe\r\n" +
  "N:Doe;Jane;;;\r\n" +
  "ORG:Acme;Sales\r\n" +
  "TITLE:VP\r\n" +
  "EMAIL;TYPE=INTERNET;TYPE=WORK;TYPE=pref:jane@acme.com\r\n" +
  "TEL;TYPE=CELL;TYPE=VOICE;TYPE=pref:+1 415 555 0100\r\n" +
  "TEL;TYPE=WORK;TYPE=VOICE:+1 415 555 0200\r\n" +
  "ADR;TYPE=WORK:;;123 Main St, Suite 4;San Francisco;CA;94105;USA\r\n" +
  "URL;TYPE=LinkedIn:https://linkedin.com/in/jane\r\n" +
  "NOTE:Loves coffee\\, tea\\; and cake\r\n" +
  "END:VCARD\r\n";

describe("parseVCard", () => {
  it("parses core iOS fields", () => {
    const p = parseVCard(IOS_VCARD);
    expect(p).not.toBeNull();
    expect(p!.uid).toBe("11111111-2222-3333-4444-555555555555");
    expect(p!.name).toBe("Jane Doe");
    expect(p!.email).toBe("jane@acme.com");
    expect(p!.company).toBe("Acme");
    expect(p!.title).toBe("VP");
    expect(p!.notes).toBe("Loves coffee, tea; and cake");
    expect(p!.linkedin).toContain("linkedin.com/in/jane");
  });

  it("parses phones with TYPE + PREF", () => {
    const p = parseVCard(IOS_VCARD)!;
    expect(p.phones).toHaveLength(2);
    const mobile = p.phones.find((x) => x.label === "Mobile")!;
    expect(mobile.is_primary).toBe(true);
    expect(mobile.number).toContain("415");
    expect(p.phones.some((x) => x.label === "Work")).toBe(true);
  });

  it("parses ADR into split lines + city/region/postal", () => {
    const p = parseVCard(IOS_VCARD)!;
    expect(p.address_line1).toBe("123 Main St");
    expect(p.address_line2).toBe("Suite 4");
    expect(p.city).toBe("San Francisco");
    expect(p.region).toBe("CA");
    expect(p.postal_code).toBe("94105");
    expect(p.country).toBe("USA");
  });

  it("unfolds continuation lines", () => {
    const folded =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Long \r\n Name Here\r\nEND:VCARD\r\n";
    expect(parseVCard(folded)!.name).toBe("Long Name Here");
  });

  it("returns null for non-vCard input", () => {
    expect(parseVCard("nope")).toBeNull();
  });

  it("dedupes duplicate phone numbers", () => {
    const dup =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:X\r\nTEL:+1 555\r\nTEL:+1 555\r\nEND:VCARD\r\n";
    expect(parseVCard(dup)!.phones).toHaveLength(1);
  });

  it("parses iOS grouped `itemN.` properties (EMAIL/TEL/URL/ADR)", () => {
    // iOS emits this shape whenever a field has an X-ABLabel or, often, for
    // the first EMAIL on a newly created contact. The parser must strip the
    // group prefix so the base property still populates the parsed fields.
    const grouped =
      "BEGIN:VCARD\r\n" +
      "VERSION:3.0\r\n" +
      "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n" +
      "FN:Grouped Person\r\n" +
      "item1.EMAIL;type=INTERNET;type=pref:person@example.com\r\n" +
      "item1.X-ABLabel:_$!<Work>!$_\r\n" +
      "item2.TEL;type=CELL;type=pref:+1 555 111 2222\r\n" +
      "item3.URL:https://linkedin.com/in/person\r\n" +
      "item3.X-ABLabel:LinkedIn\r\n" +
      "END:VCARD\r\n";
    const p = parseVCard(grouped)!;
    expect(p.email).toBe("person@example.com");
    expect(p.presentFields.has("EMAIL")).toBe(true);
    expect(p.phones).toHaveLength(1);
    expect(p.phones[0].number).toContain("555");
    expect(p.presentFields.has("TEL")).toBe(true);
    expect(p.linkedin).toContain("linkedin.com/in/person");
    expect(p.presentFields.has("LINKEDIN")).toBe(true);
  });

  it("does not mark EMAIL present when the value is empty", () => {
    // iOS partial syncs sometimes include an empty EMAIL slot. Honoring it
    // as `present` would let handlePut null the saved address.
    const emptyEmail =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:X\r\n" +
      "EMAIL;TYPE=INTERNET;TYPE=pref:\r\n" +
      "END:VCARD\r\n";
    const p = parseVCard(emptyEmail)!;
    expect(p.email).toBeNull();
    expect(p.presentFields.has("EMAIL")).toBe(false);
  });

  it("keeps the real EMAIL when a later PREF EMAIL is blank", () => {
    const mixed =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:X\r\n" +
      "EMAIL;TYPE=INTERNET;TYPE=WORK:jane@acme.com\r\n" +
      "EMAIL;TYPE=INTERNET;TYPE=pref:\r\n" +
      "END:VCARD\r\n";
    const p = parseVCard(mixed)!;
    expect(p.email).toBe("jane@acme.com");
    expect(p.presentFields.has("EMAIL")).toBe(true);
  });

  it("does not mark TEL/ORG present when their values are empty", () => {
    const blanks =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:X\r\n" +
      "TEL:\r\nORG:\r\nEND:VCARD\r\n";
    const p = parseVCard(blanks)!;
    expect(p.phones).toHaveLength(0);
    expect(p.presentFields.has("TEL")).toBe(false);
    expect(p.presentFields.has("ORG")).toBe(false);
    expect(p.company).toBeNull();
  });
});


