// Guards for the PHOTO round-trip and the iOS "echo" hash used by the
// CardDAV PUT handler to avoid freezing a company-logo fallback into
// `contacts.avatar_url`.
//
// These are pure tests: they exercise `contactToVCard`, `parseVCard`, and
// the `known-logos` cache helpers without touching the DB. The PUT handler
// itself is thin glue on top of these primitives — if the round-trip and
// the SHA determinism hold, the echo guard cannot silently regress.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseVCard, contactToVCard } from "./vcard";
import { sha256Hex } from "@/lib/contacts/photos.server";
import type { DecryptedContact } from "@/lib/sync/encrypted-reader";

function baseContact(overrides: Partial<DecryptedContact> = {}): DecryptedContact {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    user_id: "u",
    email: "erica@fsg.example",
    name: "Erica Roy",
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

// A tiny but distinctive byte pattern is fine — we just need
// determinism through encode → decode → hash.
function fixtureBytes(): Uint8Array {
  const b = new Uint8Array(1024);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

describe("PHOTO inlining (contactToVCard)", () => {
  it("inlines PNG bytes as base64 with ENCODING=b and TYPE=PNG", () => {
    const bytes = fixtureBytes();
    const vcard = contactToVCard(baseContact(), [], [], [], {
      bytes,
      mime: "image/png",
    });
    expect(vcard).toContain("PHOTO;ENCODING=b;TYPE=PNG:");
    // Base64 payload must actually be present (folded lines allowed).
    const flat = vcard.replace(/\r\n[ \t]/g, "");
    expect(flat).toMatch(/PHOTO;ENCODING=b;TYPE=PNG:[A-Za-z0-9+/=]+/);
  });

  it("emits TYPE=JPEG for image/jpeg", () => {
    const vcard = contactToVCard(baseContact(), [], [], [], {
      bytes: fixtureBytes(),
      mime: "image/jpeg",
    });
    expect(vcard).toContain("PHOTO;ENCODING=b;TYPE=JPEG:");
  });

  it("omits PHOTO entirely when no photo is provided", () => {
    const vcard = contactToVCard(baseContact(), [], [], [], null);
    expect(vcard).not.toContain("PHOTO");
  });

  it("omits PHOTO when bytes are empty (no zero-byte placeholder)", () => {
    const vcard = contactToVCard(baseContact(), [], [], [], {
      bytes: new Uint8Array(0),
      mime: "image/png",
    });
    expect(vcard).not.toContain("PHOTO");
  });
});

describe("PHOTO parsing (parseVCard)", () => {
  it("round-trips inline PHOTO bytes exactly", async () => {
    const original = fixtureBytes();
    const vcard = contactToVCard(baseContact(), [], [], [], {
      bytes: original,
      mime: "image/png",
    });
    const parsed = parseVCard(vcard);
    if (!parsed) throw new Error("parse failed");
    expect(parsed.photo).not.toBeNull();
    expect(parsed.photo!.mime).toBe("image/png");
    expect(parsed.photo!.bytes.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(parsed.photo!.bytes[i]).toBe(original[i]);
    }
    expect(parsed.presentFields.has("PHOTO")).toBe(true);
  });

  it("preserves SHA-256 through encode → parse (echo-guard invariant)", async () => {
    // The PUT handler compares sha256(incoming.bytes) against
    // `company_logo_photo_sha` and the currently stored avatar SHA. If
    // encode/decode ever corrupted a byte, echo detection would silently
    // fail and iOS PUTs would freeze the wrong avatar.
    const original = fixtureBytes();
    const shaBefore = await sha256Hex(original);
    const vcard = contactToVCard(baseContact(), [], [], [], {
      bytes: original,
      mime: "image/jpeg",
    });
    const parsed = parseVCard(vcard);
    if (!parsed) throw new Error("parse failed");
    const shaAfter = await sha256Hex(parsed.photo!.bytes);
    expect(shaAfter).toBe(shaBefore);
  });

  it("returns null photo for an empty PHOTO slot (partial-PUT preserve)", () => {
    // iOS sometimes PUTs `PHOTO;ENCODING=b;TYPE=JPEG:` with no payload
    // during partial edits. The parser must not surface phantom bytes
    // that would overwrite the existing avatar with an empty picture.
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "FN:Erica Roy",
      "N:Roy;Erica;;;",
      "PHOTO;ENCODING=b;TYPE=JPEG:",
      "END:VCARD",
    ].join("\r\n");
    const parsed = parseVCard(vcard);
    if (!parsed) throw new Error("parse failed");
    expect(parsed.photo).toBeNull();
  });

  it("ignores PHOTO;VALUE=URI (external URL not inlined)", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "FN:Erica Roy",
      "N:Roy;Erica;;;",
      "PHOTO;VALUE=uri:https://example.com/pic.jpg",
      "END:VCARD",
    ].join("\r\n");
    const parsed = parseVCard(vcard);
    if (!parsed) throw new Error("parse failed");
    expect(parsed.photo).toBeNull();
  });

  it("tolerates malformed base64 without throwing", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "FN:Erica Roy",
      "N:Roy;Erica;;;",
      "PHOTO;ENCODING=b;TYPE=JPEG:!!!not-base-64!!!",
      "END:VCARD",
    ].join("\r\n");
    expect(() => parseVCard(vcard)).not.toThrow();
    const parsed = parseVCard(vcard);
    if (!parsed) throw new Error("parse failed");
    expect(parsed.photo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// known-logos cache: verifies the CardDAV PUT hot path fetches logos once
// per user per TTL window and clears cleanly on explicit invalidation.
// ---------------------------------------------------------------------------

const mockLogoFetch = vi.fn();
const mockChoicesRows: Array<{ domain: string }> = [];
const mockDomainsRows: Array<{ domain: string }> = [];

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from(table: string) {
      const rows =
        table === "company_logo_choices"
          ? mockChoicesRows
          : table === "company_domains"
            ? mockDomainsRows
            : [];
      return {
        select() {
          const result = Promise.resolve({ data: rows, error: null });
          const chain = {
            eq() {
              return {
                order() {
                  return { limit: () => result };
                },
                then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
                  result.then(onF, onR),
              };
            },
          };
          return chain;
        },
      };

    },
  },
}));

vi.mock("@/lib/contacts/logo-photo.server", () => ({
  fetchChosenCompanyLogoBytes: (userId: string, domain: string) =>
    mockLogoFetch(userId, domain),
}));

describe("buildKnownCompanyLogoShaSet", () => {
  beforeEach(() => {
    mockLogoFetch.mockReset();
    mockChoicesRows.length = 0;
    mockDomainsRows.length = 0;
  });

  it("hashes every fetched logo and dedupes across choices + domains", async () => {
    mockChoicesRows.push({ domain: "fsg.example" });
    mockDomainsRows.push({ domain: "FSG.example" }, { domain: "nissan.example" });
    mockLogoFetch.mockImplementation(async (_u: string, domain: string) => ({
      bytes: new TextEncoder().encode(`logo:${domain.toLowerCase()}`),
      mime: "image/png",
    }));

    const { buildKnownCompanyLogoShaSet, invalidateKnownCompanyLogoShaCache } =
      await import("@/lib/contacts/known-logos.server");
    invalidateKnownCompanyLogoShaCache("user-a");

    const shas = await buildKnownCompanyLogoShaSet("user-a", { useCache: false });
    // fsg.example appears twice with different casing → dedupes to one fetch.
    expect(mockLogoFetch).toHaveBeenCalledTimes(2);
    expect(shas.size).toBe(2);
    const expectedFsg = await sha256Hex(new TextEncoder().encode("logo:fsg.example"));
    expect(shas.has(expectedFsg)).toBe(true);
  });

  it("serves cached SHAs on the second call within TTL", async () => {
    mockChoicesRows.push({ domain: "fsg.example" });
    mockLogoFetch.mockResolvedValue({
      bytes: new TextEncoder().encode("logo:fsg.example"),
      mime: "image/png",
    });

    const { buildKnownCompanyLogoShaSet, invalidateKnownCompanyLogoShaCache } =
      await import("@/lib/contacts/known-logos.server");
    invalidateKnownCompanyLogoShaCache("user-b");

    await buildKnownCompanyLogoShaSet("user-b");
    await buildKnownCompanyLogoShaSet("user-b");
    expect(mockLogoFetch).toHaveBeenCalledTimes(1);

    invalidateKnownCompanyLogoShaCache("user-b");
    await buildKnownCompanyLogoShaSet("user-b");
    expect(mockLogoFetch).toHaveBeenCalledTimes(2);
  });

  it("swallows provider errors so one bad domain can't poison the set", async () => {
    mockChoicesRows.push({ domain: "good.example" }, { domain: "bad.example" });
    mockLogoFetch.mockImplementation(async (_u: string, domain: string) => {
      if (domain === "bad.example") throw new Error("provider down");
      return {
        bytes: new TextEncoder().encode(`logo:${domain}`),
        mime: "image/png",
      };
    });

    const { buildKnownCompanyLogoShaSet, invalidateKnownCompanyLogoShaCache } =
      await import("@/lib/contacts/known-logos.server");
    invalidateKnownCompanyLogoShaCache("user-c");

    const shas = await buildKnownCompanyLogoShaSet("user-c", { useCache: false });
    expect(shas.size).toBe(1);
    const good = await sha256Hex(new TextEncoder().encode("logo:good.example"));
    expect(shas.has(good)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Regression: photos saved via the iPhone (CardDAV PUT) must be treated as
// user-chosen and never wiped by the getContact self-heal, regardless of
// whether the contact has a linked company. Enforced by two contracts:
//   1. handlers.server.ts persists surviving PUT photos with
//      source="user_upload" (not "carddav").
//   2. crud.functions.ts skips the self-heal for both "user_upload" and the
//      legacy "carddav" label.
// A behavioural end-to-end test would require stubbing the full CardDAV +
// Supabase stack; asserting the two source contracts is cheaper and prevents
// silent regressions.
// ---------------------------------------------------------------------------

describe("iPhone photo save is treated as authoritative", () => {
  it("PUT handler saves surviving photos with source=\"user_upload\"", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(process.cwd(), "src/lib/carddav/handlers.server.ts"),
      "utf8",
    );
    // Exactly one saveContactPhoto call in the PUT photo branch, and it
    // must use "user_upload".
    const saveCalls = [...src.matchAll(/saveContactPhoto\([^)]*\)/g)].map((m) => m[0]);
    expect(saveCalls.length).toBeGreaterThan(0);
    for (const call of saveCalls) {
      expect(call).toContain('"user_upload"');
      expect(call).not.toContain('"carddav"');
    }
  });

  it("getContact self-heal exempts both user_upload and legacy carddav sources", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(process.cwd(), "src/lib/contacts/crud.functions.ts"),
      "utf8",
    );
    expect(src).toMatch(/avatarSource === "user_upload"/);
    expect(src).toMatch(/avatarSource === "carddav"/);
  });
});
