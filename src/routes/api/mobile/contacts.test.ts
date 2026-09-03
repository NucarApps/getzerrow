// Authorised-path contract for POST /api/mobile/contacts — the iOS card
// scanner: an image goes in, a reviewed draft comes back, and the accepted
// draft is saved as a contact.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import {
  MOBILE_USER,
  jsonBody,
  mobileRequest,
  mockMobileAuth,
  serverHandler,
} from "@/lib/__fixtures__/mobile-route-harness";
import type { CardScanDraft } from "@/lib/card-scan.server";
import { makeContactRow } from "@/lib/contacts/__fixtures__/rows";
import * as contactsRoute from "./contacts";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));
vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));

const scan = vi.hoisted(() => ({
  extractCardDraft: vi.fn<typeof import("@/lib/card-scan.server").extractCardDraft>(),
  saveScannedContact: vi.fn<typeof import("@/lib/card-scan.server").saveScannedContact>(),
}));
vi.mock("@/lib/card-scan.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/card-scan.server")>()),
  ...scan,
}));

const logError = vi.hoisted(() => vi.fn<typeof import("@/lib/log.server").logError>());
vi.mock("@/lib/log.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/log.server")>()),
  logError,
}));

const POST = serverHandler(contactsRoute, "POST");

const IMAGE = `data:image/jpeg;base64,${"A".repeat(80)}`;

const DRAFT: CardScanDraft = {
  name: "Jane Doe",
  title: "CTO",
  company: "Acme",
  email: "jane@acme.test",
  phone: "+1 555 0100",
  website: "https://acme.test",
  linkedin: null,
  twitter: null,
  phones: [{ label: "mobile", number: "+1 555 0100" }],
  address_line1: "1 Main St",
  address_line2: "Suite 4",
  city: "Springfield",
  region: "IL",
  postal_code: "62704",
  country: "US",
};

function post(body: unknown) {
  return POST(mobileRequest("/api/mobile/contacts", { body }));
}

beforeEach(() => {
  fake.reset();
  scan.extractCardDraft.mockResolvedValue(DRAFT);
  scan.saveScannedContact.mockResolvedValue({ contact: makeContactRow({ id: "c-1" }) });
});

describe("kind:scan", () => {
  it("hands the photo to the extractor and returns the draft unchanged", async () => {
    const res = await post({ kind: "scan", image_data_url: IMAGE });
    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, draft: DRAFT });
    expect(scan.extractCardDraft).toHaveBeenCalledWith(IMAGE);
    expect(writeCount(fake)).toBe(0);
  });

  it.each([
    ["a non-image data URL", `data:application/pdf;base64,${"A".repeat(80)}`],
    ["a plain http URL", `https://cdn.test/${"a".repeat(80)}.jpg`],
    ["a too-short payload", "data:image/png;base64,AAAA"],
  ])("refuses %s with 400 and never calls the model", async (_label, image_data_url) => {
    const res = await post({ kind: "scan", image_data_url });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request body");
    expect(scan.extractCardDraft).not.toHaveBeenCalled();
  });

  it("turns an extraction failure into a 400 with the message and logs it", async () => {
    scan.extractCardDraft.mockRejectedValue(new Error("Couldn't read the card"));
    const res = await post({ kind: "scan", image_data_url: IMAGE });
    expect(await jsonBody(res, 400)).toStrictEqual({
      ok: false,
      error: "Couldn't read the card",
    });
    expect(logError).toHaveBeenCalledWith(
      "mobile_contacts_failed",
      { userId: MOBILE_USER, kind: "scan" },
      expect.any(Error),
    );
  });
});

describe("kind:create", () => {
  it("saves the reviewed draft for the calling user and echoes the contact", async () => {
    const contact = makeContactRow({ id: "c-1", email: "jane@acme.test" });
    scan.saveScannedContact.mockResolvedValue({ contact });

    const res = await post({
      kind: "create",
      email: "  Jane@ACME.test  ",
      name: "Jane Doe",
      title: "CTO",
      company: "Acme",
      phone: "+1 555 0100",
      website: "https://acme.test",
      linkedin: null,
      twitter: null,
      address_line1: " 1 Main St ",
      address_line2: "Suite 4",
      city: "Springfield",
      region: "IL",
      postal_code: "62704",
      country: "US",
      card_image_url: "cards/u1/front.jpg",
      phones: [{ label: "Mobile", number: " +1  555  0100 ", is_primary: true }],
    });

    expect(await jsonBody(res, 200)).toStrictEqual({ ok: true, contact });
    expect(scan.saveScannedContact).toHaveBeenCalledWith(MOBILE_USER, {
      // Trimmed and lower-cased by the schema before it reaches the saver.
      email: "jane@acme.test",
      name: "Jane Doe",
      title: "CTO",
      company: "Acme",
      phone: "+1 555 0100",
      website: "https://acme.test",
      linkedin: null,
      twitter: null,
      address_line1: "1 Main St",
      address_line2: "Suite 4",
      city: "Springfield",
      region: "IL",
      postal_code: "62704",
      country: "US",
      card_image_url: "cards/u1/front.jpg",
      // Runs of whitespace inside a number collapse to one space.
      phones: [{ label: "Mobile", number: "+1 555 0100", is_primary: true }],
    });
  });

  it("passes undefined for every field the app left out", async () => {
    await post({ kind: "create", email: "jane@acme.test" });
    expect(scan.saveScannedContact).toHaveBeenCalledWith(MOBILE_USER, {
      email: "jane@acme.test",
      name: undefined,
      title: undefined,
      company: undefined,
      phone: undefined,
      website: undefined,
      linkedin: undefined,
      twitter: undefined,
      address_line1: undefined,
      address_line2: undefined,
      city: undefined,
      region: undefined,
      postal_code: undefined,
      country: undefined,
      card_image_url: undefined,
      phones: undefined,
    });
  });

  it.each([
    ["a missing email", { kind: "create" }],
    ["a malformed email", { kind: "create", email: "nope" }],
    [
      "a phone number with illegal characters",
      { kind: "create", email: "a@b.test", phones: [{ label: "cell", number: "555<script>" }] },
    ],
    [
      "a two-character phone number",
      { kind: "create", email: "a@b.test", phones: [{ label: "cell", number: "12" }] },
    ],
    [
      "an empty phone label",
      { kind: "create", email: "a@b.test", phones: [{ label: "  ", number: "5550100" }] },
    ],
    [
      "more than twenty phones",
      {
        kind: "create",
        email: "a@b.test",
        phones: Array.from({ length: 21 }, () => ({ label: "cell", number: "5550100" })),
      },
    ],
    [
      "a card image path that escapes the allowed alphabet",
      { kind: "create", email: "a@b.test", card_image_url: "https://evil.test/x.jpg?a=1" },
    ],
  ])("refuses %s with 400 and saves nothing", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid request body");
    expect(scan.saveScannedContact).not.toHaveBeenCalled();
  });

  it("turns a save failure into a 400 with the message and logs it", async () => {
    scan.saveScannedContact.mockRejectedValue(new Error("duplicate key value"));
    const res = await post({ kind: "create", email: "jane@acme.test" });
    expect(await jsonBody(res, 400)).toStrictEqual({ ok: false, error: "duplicate key value" });
    expect(logError).toHaveBeenCalledWith(
      "mobile_contacts_failed",
      { userId: MOBILE_USER, kind: "create" },
      expect.any(Error),
    );
  });
});

describe("request validation", () => {
  it("refuses a body that is not JSON", async () => {
    const res = await POST(mobileRequest("/api/mobile/contacts", { rawBody: "<html>" }));
    expect(res.status).toBe(400);
    expect(scan.extractCardDraft).not.toHaveBeenCalled();
    expect(scan.saveScannedContact).not.toHaveBeenCalled();
  });

  it("refuses an unknown kind", async () => {
    expect((await post({ kind: "enrich", email: "a@b.test" })).status).toBe(400);
  });
});
