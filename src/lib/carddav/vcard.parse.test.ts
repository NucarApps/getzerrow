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
});
