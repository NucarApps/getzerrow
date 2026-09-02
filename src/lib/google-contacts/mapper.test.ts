import { describe, expect, it } from "vitest";
import {
  contactToPerson,
  personToContact,
  splitName,
  joinName,
  labelToGroupName,
  type LocalContact,
  type Person,
} from "./mapper";

const baseContact: LocalContact = {
  id: "c1",
  email: "jane@acme.com",
  name: "Jane Marie Doe",
  title: "VP Sales",
  company: "Acme",
  website: "https://acme.com",
  linkedin: "https://linkedin.com/in/jane",
  twitter: null,
  address_line1: "123 Main St",
  address_line2: "Suite 4",
  city: "San Francisco",
  region: "CA",
  postal_code: "94105",
  country: "USA",
  notes: "Loves coffee",
  primary_phone: "+1 415 555 0100",
};

describe("splitName / joinName", () => {
  it("handles single-word names", () => {
    expect(splitName("Cher")).toEqual({ givenName: "Cher", displayName: "Cher" });
    expect(joinName({ givenName: "Cher", displayName: "Cher" })).toBe("Cher");
  });
  it("splits multi-word names on whitespace", () => {
    expect(splitName("Jane Marie Doe")).toEqual({
      givenName: "Jane",
      familyName: "Marie Doe",
      displayName: "Jane Marie Doe",
    });
  });
  it("prefers displayName when present", () => {
    expect(joinName({ givenName: "J", familyName: "D", displayName: "Jane D." })).toBe("Jane D.");
  });
  it("returns null on empty input", () => {
    expect(splitName(null)).toBeNull();
    expect(splitName("   ")).toBeNull();
    expect(joinName(undefined)).toBeNull();
  });
});

describe("contactToPerson", () => {
  it("maps a full contact with phones and group memberships", () => {
    const p = contactToPerson(
      baseContact,
      [
        { label: "mobile", number: "+1 415 555 0100", is_primary: true },
        { label: "work", number: "+1 415 555 0200", is_primary: false },
      ],
      ["contactGroups/abc123"],
    );
    expect(p.names).toEqual([
      { givenName: "Jane", familyName: "Marie Doe", displayName: "Jane Marie Doe" },
    ]);
    expect(p.emailAddresses?.[0]?.value).toBe("jane@acme.com");
    expect(p.phoneNumbers).toHaveLength(2);
    expect(p.phoneNumbers?.[0]?.metadata?.primary).toBe(true);
    expect(p.organizations?.[0]).toEqual({ name: "Acme", title: "VP Sales" });
    expect(p.biographies?.[0]?.value).toBe("Loves coffee");
    expect(p.addresses?.[0]).toMatchObject({
      city: "San Francisco",
      region: "CA",
      postalCode: "94105",
      country: "USA",
    });
    expect(p.urls?.some((u) => u.type === "homepage" && u.value === "https://acme.com")).toBe(true);
    expect(p.memberships).toEqual([
      { contactGroupMembership: { contactGroupResourceName: "contactGroups/abc123" } },
    ]);
  });

  it("dedupes duplicate phone numbers", () => {
    const p = contactToPerson(
      baseContact,
      [
        { label: "mobile", number: "+1 415 555 0100", is_primary: true },
        { label: "home", number: "+1 415 555 0100", is_primary: false },
      ],
      [],
    );
    expect(p.phoneNumbers).toHaveLength(1);
  });

  it("omits optional sections when data is missing", () => {
    const minimal = contactToPerson(
      {
        ...baseContact,
        title: null,
        company: null,
        notes: null,
        address_line1: null,
        address_line2: null,
        city: null,
        region: null,
        postal_code: null,
        country: null,
        website: null,
        linkedin: null,
        twitter: null,
        primary_phone: null,
      },
      [],
      [],
    );
    expect(minimal.organizations).toBeUndefined();
    expect(minimal.biographies).toBeUndefined();
    expect(minimal.addresses).toBeUndefined();
    expect(minimal.urls).toBeUndefined();
    expect(minimal.phoneNumbers).toBeUndefined();
    expect(minimal.memberships).toBeUndefined();
  });

  it("omits emailAddresses when the local contact has no email", () => {
    const p = contactToPerson({ ...baseContact, email: null }, [], []);
    expect(p.emailAddresses).toBeUndefined();
  });
});

describe("personToContact", () => {
  const person: Person = {
    resourceName: "people/c123",
    etag: "etag-1",
    metadata: { sources: [{ updateTime: "2026-01-01T12:00:00Z" }] },
    names: [{ displayName: "Jane Marie Doe", givenName: "Jane", familyName: "Marie Doe" }],
    emailAddresses: [{ value: "jane@acme.com", metadata: { primary: true } }],
    phoneNumbers: [
      { value: "+1 415 555 0100", type: "MOBILE", metadata: { primary: true } },
      { value: "+1 415 555 0200", type: "work" },
    ],
    organizations: [{ name: "Acme", title: "VP" }],
    biographies: [{ value: "Loves coffee" }],
    addresses: [
      {
        streetAddress: "123 Main St",
        city: "SF",
        region: "CA",
        postalCode: "94105",
        country: "USA",
      },
    ],
    urls: [
      { value: "https://acme.com", type: "homepage" },
      { value: "https://linkedin.com/in/jane", type: "LinkedIn" },
    ],
    memberships: [
      { contactGroupMembership: { contactGroupResourceName: "contactGroups/abc" } },
      { contactGroupMembership: { contactGroupResourceName: "contactGroups/xyz" } },
    ],
  };

  it("extracts the primary email and writable fields", () => {
    const parsed = personToContact(person);
    expect(parsed.email).toBe("jane@acme.com");
    expect(parsed.patch.name).toBe("Jane Marie Doe");
    expect(parsed.patch.company).toBe("Acme");
    expect(parsed.patch.title).toBe("VP");
    expect(parsed.patch.notes).toBe("Loves coffee");
    expect(parsed.patch.city).toBe("SF");
    expect(parsed.patch.website).toBe("https://acme.com");
    expect(parsed.patch.linkedin).toBe("https://linkedin.com/in/jane");
    expect(parsed.patch.primary_phone).toBe("+1 415 555 0100");
    expect(parsed.phones).toHaveLength(2);
    expect(parsed.phones[0]!.is_primary).toBe(true);
    expect(parsed.membershipResourceNames).toEqual(["contactGroups/abc", "contactGroups/xyz"]);
    expect(parsed.updateTime).toBe("2026-01-01T12:00:00Z");
  });

  it("returns null email when the person has none", () => {
    const parsed = personToContact({ ...person, emailAddresses: undefined });
    expect(parsed.email).toBeNull();
  });
});

describe("labelToGroupName", () => {
  it("returns null for system groups", () => {
    expect(labelToGroupName({ name: "Family", groupType: "SYSTEM_CONTACT_GROUP" })).toBeNull();
  });
  it("returns the trimmed name for user groups", () => {
    expect(labelToGroupName({ name: "  VIPs  ", groupType: "USER_CONTACT_GROUP" })).toBe("VIPs");
  });
});

describe("push → pull round-trip", () => {
  // The two mappers are each other's inverse in production: push writes the
  // Person, and the next incremental pull reads it back. Anything the pair
  // does not preserve is silently destroyed on the account — which is how
  // the second address line used to disappear (folded into streetAddress
  // with a comma on the way out, read back as line 1 on the way in).
  const phones = [
    { label: "mobile", number: "+1 415 555 0100", is_primary: true },
    { label: "work", number: "+1 415 555 0200", is_primary: false },
  ];
  const emails = [
    { label: "work", address: "jane@acme.com", is_primary: true },
    { label: "home", address: "jane@home.example", is_primary: false },
  ];

  it("preserves every mapped contact field", () => {
    const person = contactToPerson(baseContact, phones, [], undefined, emails);
    const back = personToContact(person);

    expect(back.patch).toMatchObject({
      name: baseContact.name,
      company: baseContact.company,
      title: baseContact.title,
      address_line1: baseContact.address_line1,
      address_line2: baseContact.address_line2,
      city: baseContact.city,
      region: baseContact.region,
      postal_code: baseContact.postal_code,
      country: baseContact.country,
      notes: baseContact.notes,
      website: baseContact.website,
      linkedin: baseContact.linkedin,
    });
    expect(back.phones.map((p) => p.number)).toEqual(phones.map((p) => p.number));
    expect(back.emails.map((e) => e.address)).toEqual(emails.map((e) => e.address));
    expect(back.emails.find((e) => e.is_primary)?.address).toBe("jane@acme.com");
  });

  it("keeps a single-line address on line 1 and leaves line 2 empty", () => {
    const person = contactToPerson({ ...baseContact, address_line2: null }, [], []);
    expect(personToContact(person).patch).toMatchObject({
      address_line1: "123 Main St",
      address_line2: null,
    });
  });

  it("reads a multi-line streetAddress from Google's own UI into both lines", () => {
    // Google writes newlines into streetAddress and leaves extendedAddress
    // unset, so the pull has to split rather than trust extendedAddress.
    const parsed = personToContact({
      addresses: [{ streetAddress: "123 Main St\nSuite 4", city: "SF" }],
    });
    expect(parsed.patch).toMatchObject({ address_line1: "123 Main St", address_line2: "Suite 4" });
  });

  it("promotes the first email when the local set names no primary", () => {
    const person = contactToPerson(baseContact, [], [], undefined, [
      { label: "work", address: "a@x.com", is_primary: false },
      { label: "home", address: "b@x.com", is_primary: false },
    ]);
    expect(person.emailAddresses?.[0]).toMatchObject({ value: "a@x.com" });
    expect(personToContact(person).emails[0]).toMatchObject({
      address: "a@x.com",
      is_primary: true,
    });
  });

  it("dedupes emails differing only in case", () => {
    const person = contactToPerson(baseContact, [], [], undefined, [
      { label: "work", address: "Jane@Acme.com", is_primary: true },
      { label: "home", address: "jane@acme.com", is_primary: false },
    ]);
    expect(personToContact(person).emails).toHaveLength(1);
  });
});
