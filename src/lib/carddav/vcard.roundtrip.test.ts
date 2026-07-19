// Round-trip guards: iOS → parse → server model → serialize → parse must
// preserve phone, email, and notes without duplicating or corrupting them.
import { describe, it, expect } from "vitest";
import {
  parseVCard,
  contactToVCard,
  phoneKey,
  buildMergedNote,
  stripSummaryFromNote,
  type PhoneRow,
} from "./vcard";
import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

function buildContact(overrides: Partial<DecryptedContact> = {}): DecryptedContact {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    user_id: "u",
    email: "jane@acme.com",
    name: "Jane Doe",
    avatar_url: null,
    title: null,
    company: null,
    phone: null,
    website: null,
    card_image_url: null,
    address_line1: null,
    address_line2: null,
    city: null,
    region: null,
    postal_code: null,
    country: null,
    linkedin: null,
    twitter: null,
    relationship_summary: null,
    summary_generated_at: null,
    notes: null,
    source: "carddav",
    enriched_at: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  } as DecryptedContact;
}

describe("phoneKey", () => {
  it("normalizes formatting differences", () => {
    expect(phoneKey("+1 415 555 0100")).toBe("14155550100");
    expect(phoneKey("(415) 555-0100")).toBe("4155550100");
    expect(phoneKey("+1-415-555-0100")).toBe("14155550100");
  });
});

describe("phone round-trip", () => {
  it("does not duplicate a reformatted encrypted-phone number", () => {
    const c = buildContact({ phone: "+1 (415) 555-0100" });
    const phones: PhoneRow[] = [{ label: "Mobile", number: "+14155550100", is_primary: true }];
    const vcard = contactToVCard(c, phones);
    const telLines = vcard.split("\r\n").filter((l) => l.startsWith("TEL"));
    // Only ONE TEL should be emitted even though the two numbers differ in
    // formatting — same digits.
    expect(telLines.length).toBe(1);
  });

  it("preserves is_primary via PREF=1 across a full round-trip", () => {
    const c = buildContact();
    const phones: PhoneRow[] = [
      { label: "Home", number: "+14155550200", is_primary: false },
      { label: "Mobile", number: "+14155550100", is_primary: true },
    ];
    const vcard = contactToVCard(c, phones);
    const parsed = parseVCard(vcard);
    expect(parsed).not.toBeNull();
    const primary = parsed!.phones.find((p) => p.is_primary);
    expect(primary?.number).toBe("+14155550100");
    expect(primary?.label).toBe("Mobile");
  });

  it("recognizes iOS PREF=1 form on input", () => {
    const iosCard =
      "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:X\r\n" +
      "TEL;TYPE=CELL;PREF=1:+1 415 555 0100\r\n" +
      "TEL;TYPE=HOME:+1 415 555 0200\r\n" +
      "END:VCARD\r\n";
    const parsed = parseVCard(iosCard)!;
    expect(parsed.phones.find((p) => p.is_primary)?.number).toBe("+1 415 555 0100");
  });
});

describe("email round-trip", () => {
  it("preserves the address exactly", () => {
    const c = buildContact({ email: "Jane.Doe+work@Acme.com" });
    const vcard = contactToVCard(c);
    const parsed = parseVCard(vcard)!;
    // Case is preserved in the vCard; the handler lowercases on PUT.
    expect(parsed.email).toBe("Jane.Doe+work@Acme.com");
  });
});

describe("notes round-trip", () => {
  it("survives commas, semicolons, newlines, and backslashes", () => {
    const notes = "Line one\nLine, two; still\\here";
    const c = buildContact({ notes });
    const vcard = contactToVCard(c);
    const parsed = parseVCard(vcard)!;
    expect(parsed.notes).toBe(notes);
  });

  it("does not corrupt multi-byte unicode when folded past 75 octets", () => {
    // Long note with emoji + accented characters — pre-fix, folding by
    // JS char length split codepoints and produced replacement chars on parse.
    const notes = "☕ ".repeat(60) + " café façade — naïve résumé";
    const c = buildContact({ notes });
    const vcard = contactToVCard(c);
    // The serialized vCard MUST fold (contains CRLF+space) but must still
    // round-trip losslessly.
    expect(vcard).toContain("\r\n ");
    const parsed = parseVCard(vcard)!;
    expect(parsed.notes).toBe(notes);
  });

  it("does not emit legacy placeholder emails back to iOS", () => {
    // Historically we synthesized `carddav+<uuid>@local.zerrow` when iOS
    // omitted EMAIL. That fallback is gone but stale rows can linger — the
    // serializer must not echo them or iPhone displays the placeholder as
    // the real address.
    const c = buildContact({
      email: `carddav+${"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}@local.zerrow`,
    });
    const vcard = contactToVCard(c);
    expect(vcard).not.toContain("EMAIL");
    expect(vcard).not.toContain("local.zerrow");
  });
});

describe("AI summary in NOTE", () => {
  it("merges summary and user notes with summary first", () => {
    const merged = buildMergedNote("She runs ops at Acme.", "Met at conf.");
    expect(merged).toContain("🤖 Zerrow summary");
    expect(merged).toContain("She runs ops at Acme.");
    expect(merged).toContain("— My notes —");
    expect(merged).toContain("Met at conf.");
    expect(merged!.indexOf("Zerrow summary")).toBeLessThan(merged!.indexOf("— My notes —"));
  });

  it("returns user notes only when there is no summary", () => {
    expect(buildMergedNote(null, "Just notes")).toBe("Just notes");
    expect(buildMergedNote("", "Just notes")).toBe("Just notes");
  });

  it("returns null when both are empty", () => {
    expect(buildMergedNote(null, null)).toBeNull();
    expect(buildMergedNote("", "")).toBeNull();
  });

  it("emits merged NOTE in vCard when summary is present and option not disabled", () => {
    const c = buildContact({
      relationship_summary: "Head of design.",
      notes: "Prefers email.",
    });
    const vcard = contactToVCard(c);
    const unfolded = vcard.replace(/\r\n /g, "");
    expect(unfolded).toMatch(/NOTE[:;]/);
    expect(unfolded).toContain("Head of design.");
    expect(unfolded).toContain("Prefers email.");
  });

  it("omits summary when includeSummary=false", () => {
    const c = buildContact({
      relationship_summary: "Head of design.",
      notes: "Prefers email.",
    });
    const vcard = contactToVCard(c, [], [], [], null, { includeSummary: false });
    const unfolded = vcard.replace(/\r\n /g, "");
    expect(unfolded).not.toContain("Head of design.");
    expect(unfolded).toContain("Prefers email.");
  });

  it("stripSummaryFromNote returns only user portion for merged text", () => {
    const merged = buildMergedNote("AI text", "user text")!;
    expect(stripSummaryFromNote(merged)).toBe("user text");
  });

  it("stripSummaryFromNote returns empty string for summary-only inbound", () => {
    const merged = buildMergedNote("AI text", null)!;
    expect(stripSummaryFromNote(merged)).toBe("");
  });

  it("stripSummaryFromNote passes plain user notes through unchanged", () => {
    expect(stripSummaryFromNote("Just my notes")).toBe("Just my notes");
    expect(stripSummaryFromNote(null)).toBe("");
  });
});
