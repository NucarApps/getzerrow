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
    expect(p.phoneNumbers?.[0].metadata?.primary).toBe(true);
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
      { streetAddress: "123 Main St", city: "SF", region: "CA", postalCode: "94105", country: "USA" },
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
    expect(parsed.phones[0].is_primary).toBe(true);
    expect(parsed.membershipResourceNames).toEqual([
      "contactGroups/abc",
      "contactGroups/xyz",
    ]);
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
