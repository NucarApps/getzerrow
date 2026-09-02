// Business-card scanning server fns (scan.functions.ts). Contracts
// protected:
//
//   * getContactCardSignedUrl signs a private storage object, so it carries
//     TWO guards and both are asserted: the row must belong to the caller,
//     and the stored path must live under the caller's own prefix (a
//     defence against a poisoned card_image_url),
//   * scanCard / createContactFromScan pin their input contracts and hand
//     the authenticated user id — never a client-supplied one — to the
//     shared save path.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { makeContactRow } from "./__fixtures__/rows";

const fake = makeSupabaseFake();
const rls = makeSupabaseFake();

const createSignedUrl = vi.fn(async () => ({
  data: { signedUrl: "https://storage.example/signed" } as { signedUrl: string } | null,
  error: null as { message: string } | null,
}));

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
// The shared fake has no storage surface, so this mock is the fake's
// from/rpc plus a storage stub the signed-url path can drive.
vi.mock("@/integrations/supabase/client.server", async () => {
  const { mockSupabaseAdmin } = await import("@/lib/__fixtures__/supabase-fake");
  return {
    supabaseAdmin: {
      ...mockSupabaseAdmin(() => fake),
      storage: {
        from: () => ({ createSignedUrl: (...a: unknown[]) => createSignedUrl(...(a as [])) }),
      },
    },
  };
});

const extractCardDraft = vi.fn(async () => ({ name: "Ada Lovelace", email: "ada@acme.com" }));
const saveScannedContact = vi.fn(async () => ({ contact: { id: "contact-1" } }));
vi.mock("@/lib/card-scan.server", () => ({
  extractCardDraft: (...a: unknown[]) => extractCardDraft(...(a as [])),
  saveScannedContact: (...a: unknown[]) => saveScannedContact(...(a as [])),
}));

import { scanCard, createContactFromScan, getContactCardSignedUrl } from "./scan.functions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";
const DATA_URL = `data:image/png;base64,${"A".repeat(80)}`;

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };
const asAttacker = { supabase: rls.supabaseAdmin, userId: ATTACKER };

beforeEach(() => {
  fake.reset();
  rls.reset();
  extractCardDraft.mockClear();
  saveScannedContact.mockClear();
  createSignedUrl.mockClear();
  createSignedUrl.mockResolvedValue({
    data: { signedUrl: "https://storage.example/signed" },
    error: null,
  });
});

describe("getContactCardSignedUrl", () => {
  it("another tenant's contact is forbidden and no URL is ever signed", async () => {
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: VICTIM,
        card_image_url: `${VICTIM}/card.png`,
      }),
    ]);
    await expect(
      call(getContactCardSignedUrl, { data: { contactId: CONTACT_ID }, context: asAttacker }),
    ).rejects.toThrow("Forbidden");
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(writeCount(rls)).toBe(0);
  });

  it("a card path outside the caller's own storage prefix is refused", async () => {
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        // The row is the caller's, but the stored path points elsewhere.
        card_image_url: `${VICTIM}/card.png`,
      }),
    ]);
    await expect(
      call(getContactCardSignedUrl, { data: { contactId: CONTACT_ID }, context: asUser }),
    ).rejects.toThrow("Invalid path");
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("signs the owner's card for ten minutes", async () => {
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        card_image_url: `${TEST_USER}/card.png`,
      }),
    ]);
    const res = await call(getContactCardSignedUrl, {
      data: { contactId: CONTACT_ID },
      context: asUser,
    });
    expect(res).toEqual({ url: "https://storage.example/signed" });
    expect(createSignedUrl).toHaveBeenCalledWith(`${TEST_USER}/card.png`, 600);
  });

  it("a contact with no card image returns a null url without signing", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, card_image_url: null }),
    ]);
    const res = await call(getContactCardSignedUrl, {
      data: { contactId: CONTACT_ID },
      context: asUser,
    });
    expect(res).toEqual({ url: null });
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("a storage failure surfaces to the caller", async () => {
    rls.seed("contacts", [
      makeContactRow({
        id: CONTACT_ID,
        user_id: TEST_USER,
        card_image_url: `${TEST_USER}/card.png`,
      }),
    ]);
    createSignedUrl.mockResolvedValue({ data: null, error: { message: "object not found" } });
    await expect(
      call(getContactCardSignedUrl, { data: { contactId: CONTACT_ID }, context: asUser }),
    ).rejects.toThrow("object not found");
  });

  it("a missing contact is reported as not found", async () => {
    await expect(
      call(getContactCardSignedUrl, { data: { contactId: CONTACT_ID }, context: asUser }),
    ).rejects.toThrow("Contact not found");
  });
});

describe("scanCard", () => {
  it("passes the data URL to the shared extractor", async () => {
    const res = await call(scanCard, { data: { imageDataUrl: DATA_URL }, context: asUser });
    expect(res).toEqual({ draft: { name: "Ada Lovelace", email: "ada@acme.com" } });
    expect(extractCardDraft).toHaveBeenCalledWith(DATA_URL, "scanCard");
  });

  it("zod rejects a non-image URL, a too-short payload and an oversize one", async () => {
    await expect(
      scanCard({ data: { imageDataUrl: `https://evil.test/${"a".repeat(80)}` } }),
    ).rejects.toThrow();
    await expect(
      scanCard({ data: { imageDataUrl: "data:image/png;base64,AA" } }),
    ).rejects.toThrow();
    await expect(
      scanCard({ data: { imageDataUrl: `data:image/png;base64,${"A".repeat(15_000_001)}` } }),
    ).rejects.toThrow();
    expect(extractCardDraft).not.toHaveBeenCalled();
  });
});

describe("createContactFromScan", () => {
  it("saves under the authenticated user id, not one supplied by the client", async () => {
    await call(createContactFromScan, {
      data: {
        email: "Ada@Acme.com",
        name: "Ada",
        phones: [{ label: "mobile", number: "555 123 4567" }],
      },
      context: asUser,
    });
    expect(saveScannedContact).toHaveBeenCalledWith(
      TEST_USER,
      expect.objectContaining({ email: "Ada@Acme.com", name: "Ada" }),
    );
  });

  it("zod rejects a bad email, an oversize field and a traversal card path", async () => {
    await expect(createContactFromScan({ data: { email: "nope" } })).rejects.toThrow();
    await expect(
      createContactFromScan({ data: { email: "a@b.co", name: "x".repeat(201) } }),
    ).rejects.toThrow();
    await expect(
      createContactFromScan({ data: { email: "a@b.co", card_image_url: "../../etc/passwd\n" } }),
    ).rejects.toThrow();
    expect(saveScannedContact).not.toHaveBeenCalled();
  });
});
