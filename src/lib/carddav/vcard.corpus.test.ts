// A corpus of real-shaped cards from the clients that actually talk to this
// server. The unit tests around `parseVCard` use cards we wrote to suit the
// parser; these are what the clients emit, quirks included:
//
//   ios17      vCard 3.0 with itemN. grouping and X-AB* extensions
//   macos14    the same family plus X-ABShowAs and custom-labelled URLs
//   davx5-v4   vCard 4.0 with TEL;VALUE=uri:tel:… (Android/DAVx5)
//   thunderbird vCard 4.0 with KIND and an ADR;LABEL= parameter
//   android-qp vCard 2.1 with ENCODING=QUOTED-PRINTABLE and soft "=" wraps
//
// Fixtures are stored with LF for readability and converted to CRLF here,
// which is what the wire format uses and what the unfolder must cope with.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseVCard, type ParsedVCard } from "./vcard";

const VCARD_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "vcards");

function loadCard(file: string): ParsedVCard {
  const raw = readFileSync(join(VCARD_DIR, file), "utf8").replace(/\r?\n/g, "\r\n");
  const parsed = parseVCard(raw);
  if (!parsed) throw new Error(`${file} did not parse as a vCard`);
  return parsed;
}

/** Everything the CardDAV PUT path reads off a parsed card, as a plain
 * object so a card can be asserted in one payload. */
function shape(p: ParsedVCard) {
  return {
    uid: p.uid,
    name: p.name,
    company: p.company,
    title: p.title,
    email: p.email,
    emails: p.emails,
    phones: p.phones,
    address_line1: p.address_line1,
    address_line2: p.address_line2,
    city: p.city,
    region: p.region,
    postal_code: p.postal_code,
    country: p.country,
    website: p.website,
    linkedin: p.linkedin,
    twitter: p.twitter,
    notes: p.notes,
    categories: p.categories,
    isGroup: p.isGroup,
    memberUids: p.memberUids,
    presentFields: [...p.presentFields].sort(),
  };
}

describe("iOS 17 Contacts (vCard 3.0, itemN grouping)", () => {
  it("parses the whole card, stripping itemN prefixes and ignoring X-AB extensions", () => {
    expect(shape(loadCard("ios17.vcf"))).toStrictEqual({
      uid: "1a5b8c9d-2e3f-4a5b-8c9d-0e1f2a3b4c5d",
      name: "Erica Roy",
      // ORG arrives as "Acme Rockets;" — the trailing unit separator is a
      // structured-value component, not part of the name.
      company: "Acme Rockets",
      title: "Chief Pyrotechnician",
      // Case is preserved here; the PUT handler folds it before storing.
      email: "Erica.Roy@Acme.example",
      emails: [
        { label: "Work", address: "Erica.Roy@Acme.example", is_primary: true },
        { label: "Home", address: "erica@home.example", is_primary: false },
      ],
      phones: [
        { label: "Mobile", number: "+1 (555) 010-1234", is_primary: true },
        { label: "Work", number: "+1 (555) 010-9876", is_primary: false },
      ],
      // The street component carries an escaped newline, not a comma — that
      // is what keeps "Suite 4" out of the city slot on the next edit.
      address_line1: "500 Rocket Way",
      address_line2: "Suite 4",
      city: "Springfield",
      region: "IL",
      postal_code: "62704",
      country: "USA",
      website: "https://acme.example",
      linkedin: null,
      twitter: null,
      notes: "Met at the launch.",
      categories: ["Clients"],
      isGroup: false,
      memberUids: [],
      presentFields: ["ADR", "CATEGORIES", "EMAIL", "FN", "NOTE", "ORG", "TEL", "TITLE", "URL"],
    });
  });

  it("does not mistake the X-ABUID value's colon for a property separator", () => {
    // `X-ABUID:9C1B…:ABPerson` has two colons; splitting on the wrong one
    // would produce a property named after the uuid.
    const parsed = loadCard("ios17.vcf");
    expect(parsed.uid).toBe("1a5b8c9d-2e3f-4a5b-8c9d-0e1f2a3b4c5d");
    expect(parsed.website).toBe("https://acme.example");
  });
});

describe("macOS 14 Contacts (vCard 3.0, X-ABShowAs + labelled URLs)", () => {
  it("routes the custom-labelled URLs to website / linkedin / twitter", () => {
    expect(shape(loadCard("macos14.vcf"))).toStrictEqual({
      uid: "2b6c9d0e-3f4a-4b5c-8d9e-1f2a3b4c5d6e",
      name: "Ada Marie Okonkwo",
      // "Helios Labs;Research" — only the organisation name is kept, the
      // organisational unit is dropped.
      company: "Helios Labs",
      title: "Principal Scientist",
      email: "ada@helios.example",
      emails: [{ label: "Work", address: "ada@helios.example", is_primary: true }],
      phones: [
        { label: "Mobile", number: "+1 (555) 010-4242", is_primary: true },
        { label: "Work", number: "+1 (555) 010-4299", is_primary: false },
      ],
      address_line1: "77 Vine St",
      address_line2: null,
      city: "Berkeley",
      region: "CA",
      postal_code: "94704",
      country: "USA",
      website: "https://helios.example",
      linkedin: "https://www.linkedin.com/in/adaokonkwo",
      twitter: "https://x.com/adaokonkwo",
      notes: "Runs the Tuesday reading group.",
      categories: [],
      isGroup: false,
      memberUids: [],
      presentFields: [
        "ADR",
        "EMAIL",
        "FN",
        "LINKEDIN",
        "NOTE",
        "ORG",
        "TEL",
        "TITLE",
        "TWITTER",
        "URL",
      ],
    });
  });

  it("X-ABShowAs:COMPANY does not turn the card into a group", () => {
    // Only KIND / X-ADDRESSBOOKSERVER-KIND make a group card; treating a
    // "show as company" person as one would route it to the group PUT path
    // and 400 the whole request.
    expect(loadCard("macos14.vcf").isGroup).toBe(false);
  });

  it("TYPE=IPHONE is recognised as a mobile number", () => {
    expect(loadCard("macos14.vcf").phones[0]!.label).toBe("Mobile");
  });
});

describe("DAVx5 (vCard 4.0, TEL as a tel: URI)", () => {
  it("unwraps tel: URIs so the stored number is dialable", () => {
    // vCard 4.0 spells phone numbers as URIs. Storing "tel:+1555…" verbatim
    // put the scheme in front of the number everywhere it is displayed and
    // in the value pushed to Google Contacts.
    expect(shape(loadCard("davx5-v4.vcf"))).toStrictEqual({
      uid: "3c7d0e1f-4a5b-4c6d-8e9f-2a3b4c5d6e7f",
      name: "Jordan Baker",
      company: "Northwind Traders",
      title: "Logistics Lead",
      email: "Jordan.Baker@Northwind.example",
      emails: [{ label: "Work", address: "Jordan.Baker@Northwind.example", is_primary: true }],
      phones: [
        { label: "Mobile", number: "+15550101234", is_primary: true },
        { label: "Work", number: "+15550109999", is_primary: false },
      ],
      address_line1: "12 Harbour Rd",
      address_line2: null,
      city: "Portland",
      region: "OR",
      postal_code: "97205",
      country: "USA",
      website: "https://northwind.example",
      linkedin: null,
      twitter: null,
      notes: "Ships out of the Portland depot.",
      categories: [],
      isGroup: false,
      memberUids: [],
      presentFields: ["ADR", "EMAIL", "FN", "NOTE", "ORG", "TEL", "TITLE", "URL"],
    });
  });

  it("reads PREF=1 as the primary number", () => {
    const phones = loadCard("davx5-v4.vcf").phones;
    expect(phones.filter((p) => p.is_primary)).toHaveLength(1);
    expect(phones[0]!.is_primary).toBe(true);
  });
});

describe("Thunderbird (vCard 4.0, KIND + ADR;LABEL)", () => {
  it("keeps a KIND:individual card out of the group path and parses ADR past its LABEL param", () => {
    expect(shape(loadCard("thunderbird.vcf"))).toStrictEqual({
      uid: "4d8e1f2a-5b6c-4d7e-8f9a-3b4c5d6e7f80",
      name: "Priya Raman",
      company: "Cedar Analytics",
      title: null,
      email: "priya@cedar.example",
      emails: [
        // No TYPE at all on the PREF address, so it lands in the catch-all
        // label rather than being guessed at.
        { label: "Other", address: "priya@cedar.example", is_primary: true },
        { label: "Home", address: "praman@personal.example", is_primary: false },
      ],
      phones: [{ label: "Work", number: "+1 555 010 7777", is_primary: false }],
      // The LABEL parameter carries its own escaped copy of the address; the
      // structured components after the colon are still what is read.
      address_line1: "88 Cedar Ave",
      address_line2: null,
      city: "Boulder",
      region: "CO",
      postal_code: "80301",
      country: "USA",
      website: null,
      linkedin: null,
      twitter: null,
      notes: "Prefers email over calls.",
      categories: [],
      isGroup: false,
      memberUids: [],
      presentFields: ["ADR", "EMAIL", "FN", "NOTE", "ORG", "TEL"],
    });
  });
});

describe("Android exporter (vCard 2.1, quoted-printable)", () => {
  it("decodes ENCODING=QUOTED-PRINTABLE values back to their real text", () => {
    // vCard 2.1 exporters (the Android Contacts "share" flow, several
    // Windows address books) escape every non-ASCII byte as
    // ENCODING=QUOTED-PRINTABLE. Left undecoded, "Jürgen Müller" would be
    // stored, displayed and pushed to Google as "J=C3=BCrgen M=C3=BCller".
    const parsed = loadCard("android-qp.vcf");
    expect(parsed.name).toBe("Jürgen Müller");
    expect(parsed.company).toBe("Bäckerei Nord");
  });

  it("unfolds a soft '=' line break before splitting a structured ADR value", () => {
    // The ADR value wraps mid-component ("M=C3=BCnch" + "en"). Splitting on
    // ';' before joining the continuation would put half of "München" in the
    // street slot and shift every following component along by one.
    const parsed = loadCard("android-qp.vcf");
    expect({
      address_line1: parsed.address_line1,
      address_line2: parsed.address_line2,
      city: parsed.city,
      region: parsed.region,
      postal_code: parsed.postal_code,
      country: parsed.country,
    }).toStrictEqual({
      address_line1: "Hauptstraße 12",
      address_line2: null,
      city: "München",
      region: "Bayern",
      postal_code: "80331",
      country: "Deutschland",
    });
  });

  it("joins a value soft-wrapped across three lines, including a split escape", () => {
    // The NOTE spans three physical lines and the em dash's own escape is
    // torn across the first break ("=E2=80=" + "=94"), so the continuation
    // has to be joined before any '=XX' is decoded.
    expect(loadCard("android-qp.vcf").notes).toBe(
      "Grüße aus München — wir sehen uns in der Bäckerei, Gruß an alle.",
    );
  });

  it("leaves a plain 3.0 value alone when no ENCODING parameter is present", () => {
    // Decoding must be opt-in per property: an unencoded value that happens
    // to contain '=' (a URL query, a base64-looking token) must survive.
    const parsed = parseVCard(
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:A=C3=BC B",
        "URL:https://x.test/?a=3D1",
        "END:VCARD",
        "",
      ].join("\r\n"),
    );
    expect(parsed?.name).toBe("A=C3=BC B");
    expect(parsed?.website).toBe("https://x.test/?a=3D1");
  });

  it("still reads the ASCII fields, so the card is not a total loss", () => {
    const parsed = loadCard("android-qp.vcf");
    // 2.1 spells parameters as bare tokens (TEL;CELL rather than
    // TEL;TYPE=CELL); those route to TYPE so the labels still resolve.
    expect(parsed.phones).toStrictEqual([
      { label: "Mobile", number: "+49 151 12345678", is_primary: false },
      { label: "Work", number: "+49 30 9876543", is_primary: false },
    ]);
    expect(parsed.email).toBe("juergen.mueller@example.de");
    // 2.1 cards routinely carry no UID; the PUT path takes identity from the
    // URL anyway, so this must not fail the parse.
    expect(parsed.uid).toBeNull();
  });
});

describe("the corpus as a whole", () => {
  const FILES = ["ios17.vcf", "macos14.vcf", "davx5-v4.vcf", "thunderbird.vcf", "android-qp.vcf"];

  it("every client card parses, names a person, and yields no group members", () => {
    for (const file of FILES) {
      const parsed = loadCard(file);
      expect(parsed.name, `${file} produced no display name`).toBeTruthy();
      expect(parsed.isGroup, `${file} was misread as a group card`).toBe(false);
      expect(parsed.memberUids, `${file} produced group members`).toEqual([]);
    }
  });

  it("never reports a field as present without a value behind it", () => {
    // presentFields is what the PUT handler merges on: a field marked
    // present but parsed as null would blank the stored value.
    const readers: Record<string, (p: ParsedVCard) => unknown> = {
      FN: (p) => p.name,
      ORG: (p) => p.company,
      TITLE: (p) => p.title,
      EMAIL: (p) => p.emails.length,
      TEL: (p) => p.phones.length,
      ADR: (p) => p.address_line1 ?? p.city ?? p.postal_code,
      URL: (p) => p.website,
      LINKEDIN: (p) => p.linkedin,
      TWITTER: (p) => p.twitter,
      NOTE: (p) => p.notes,
      CATEGORIES: (p) => p.categories.length,
      PHOTO: (p) => p.photo,
    };
    for (const file of FILES) {
      const parsed = loadCard(file);
      for (const field of parsed.presentFields) {
        expect(readers[field]!(parsed), `${file}: ${field} marked present but empty`).toBeTruthy();
      }
    }
  });
});
