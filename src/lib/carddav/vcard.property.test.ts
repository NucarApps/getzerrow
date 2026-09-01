// Round-trip property: for a contact built from a hostile alphabet
// (`, ; \ :` newlines, folding-length runs, multibyte), serialize → parse must
// reproduce every text field, phone and email exactly. Example-based tests
// missed the `\;` structured-value bug for months; a generated corpus finds
// that class of escaping error on the first run.
//
// Deterministic: a seeded xorshift PRNG replaces a property-testing library,
// so a failure reproduces from the printed seed without a new dependency.

import { describe, it, expect } from "vitest";
import { parseVCard, contactToVCard, type PhoneRow, type EmailRow } from "./vcard";
import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

// Characters chosen to hit every escaping rule the serializer has, plus a
// few that must pass through untouched.
const ALPHABET = ["a", "b", "Z", "é", "日", " ", ",", ";", "\\", ":", "\n", "-", "4", "'", '"'];

function text(r: () => number, max = 24): string {
  const n = 1 + Math.floor(r() * max);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  // The parser trims component edges and collapses blank lines; generate
  // values that survive that so equality is exact.
  return out.replace(/\s+/g, " ").trim() || "x";
}

function maybe<T>(r: () => number, v: T): T | null {
  return r() < 0.7 ? v : null;
}

function buildContact(r: () => number): DecryptedContact {
  // Line 2 without line 1 is not a shape the model produces (the street
  // component is line1 + newline + line2), so only generate it under line1.
  const line1 = maybe(r, text(r));
  const line2 = line1 ? maybe(r, text(r)) : null;
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    user_id: "u",
    email: "primary@example.com",
    name: `${text(r, 8)} ${text(r, 8)}`,
    avatar_url: null,
    title: maybe(r, text(r)),
    company: maybe(r, text(r)),
    phone: null,
    website: null,
    card_image_url: null,
    address_line1: line1,
    address_line2: line2,
    city: maybe(r, text(r, 12)),
    region: maybe(r, text(r, 6)),
    postal_code: maybe(r, `${Math.floor(r() * 99999)}`),
    country: maybe(r, text(r, 10)),
    linkedin: null,
    twitter: null,
    relationship_summary: null,
    summary_generated_at: null,
    notes: maybe(r, text(r, 60)),
    source: "carddav",
    enriched_at: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  } as DecryptedContact;
}

describe("vCard serialize → parse round-trip (seeded property)", () => {
  const CASES = 200;
  for (let seed = 1; seed <= CASES; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed * 2654435761);
      const c = buildContact(r);
      const phones: PhoneRow[] = [
        {
          label: "Mobile",
          number: `+1415555${String(1000 + Math.floor(r() * 8999))}`,
          is_primary: true,
        },
      ];
      const emails: EmailRow[] = [
        { label: "Work", address: "primary@example.com", is_primary: true },
        { label: "Home", address: `h${seed}@example.org`, is_primary: false },
      ];

      const card = contactToVCard(c, phones, [], emails);
      const p = parseVCard(card);
      expect(p, card).not.toBeNull();

      // Structured components must land in their own slots regardless of
      // what characters they contain.
      expect(p!.company).toBe(c.company);
      expect(p!.title).toBe(c.title);
      expect(p!.address_line1).toBe(c.address_line1);
      expect(p!.address_line2).toBe(c.address_line2);
      expect(p!.city).toBe(c.city);
      expect(p!.region).toBe(c.region);
      expect(p!.postal_code).toBe(c.postal_code);
      expect(p!.country).toBe(c.country);
      expect(p!.notes).toBe(c.notes);
      expect(p!.name).toBe(c.name);

      expect(p!.phones.map((x) => x.number)).toEqual(phones.map((x) => x.number));
      expect(p!.emails.map((x) => x.address)).toEqual(emails.map((x) => x.address));
      expect(p!.email).toBe("primary@example.com");

      // And a second pass is stable: parse(serialize(parse(serialize(c)))).
      const again = parseVCard(contactToVCard({ ...c, ...pick(p!) }, phones, [], emails));
      expect(again).toEqual(p);
    });
  }
});

function pick(p: NonNullable<ReturnType<typeof parseVCard>>) {
  return {
    name: p.name,
    title: p.title,
    company: p.company,
    address_line1: p.address_line1,
    address_line2: p.address_line2,
    city: p.city,
    region: p.region,
    postal_code: p.postal_code,
    country: p.country,
    notes: p.notes,
  };
}
