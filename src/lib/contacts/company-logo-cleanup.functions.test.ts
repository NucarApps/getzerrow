// Un-freezing company-logo snapshots (company-logo-cleanup.functions.ts).
// This is the most destructive thing in the logo stack — it deletes a
// contact's stored avatar and writes a permanent company_logo_hashes row —
// so the tests are behavioural, driving the module through stubbed photo /
// logo helpers rather than reading its source. Contracts protected:
//
//   * an avatar whose bytes hash to a known company logo is cleared exactly
//     once, fingerprinted via recordCompanyLogoHash, stamped with the
//     current logo sha (so the CardDAV PUT guard recognises future echoes)
//     and followed by a CardDAV resync_nonce bump,
//   * an avatar that matches nothing is kept: no delete, no hash row, no
//     nonce bump — a false positive here is sticky and irreversible,
//   * an already-recorded hash is not re-recorded,
//   * every read and write filters on the caller's user_id, so ids from
//     another tenant are dropped from the batch,
//   * resetContactToCompanyLogo refuses a contact with no linked company
//     BEFORE deleting its photo.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  writesTo,
} from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { makeContactRow } from "./__fixtures__/rows";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const loadContactPhotoBytes = vi.fn(
  async (): Promise<{ bytes: Uint8Array; mime: string } | null> => ({
    bytes: new Uint8Array([1]),
    mime: "image/png",
  }),
);
const deleteContactPhoto = vi.fn(async () => {});
const sha256Hex = vi.fn(async (_bytes: Uint8Array) => "sha-avatar");
vi.mock("@/lib/contacts/photos.server", () => ({
  loadContactPhotoBytes: (...a: unknown[]) => loadContactPhotoBytes(...(a as [])),
  deleteContactPhoto: (...a: unknown[]) => deleteContactPhoto(...(a as [])),
  sha256Hex: (bytes: Uint8Array) => sha256Hex(bytes),
}));

const fetchChosenCompanyLogoBytes = vi.fn(
  async (): Promise<{ bytes: Uint8Array; mime: string } | null> => null,
);
const resolveCompanyLogoDomainForContact = vi.fn(async () => "acme.com" as string | null);
const getCompanyLogoVariantShas = vi.fn(async () => new Set<string>());
const getKnownCompanyLogoHashes = vi.fn(async () => new Set<string>());
const recordCompanyLogoHash = vi.fn(async () => {});
vi.mock("@/lib/contacts/logo-photo.server", () => ({
  fetchChosenCompanyLogoBytes: (...a: unknown[]) => fetchChosenCompanyLogoBytes(...(a as [])),
  resolveCompanyLogoDomainForContact: (...a: unknown[]) =>
    resolveCompanyLogoDomainForContact(...(a as [])),
  getCompanyLogoVariantShas: (...a: unknown[]) => getCompanyLogoVariantShas(...(a as [])),
  getKnownCompanyLogoHashes: (...a: unknown[]) => getKnownCompanyLogoHashes(...(a as [])),
  recordCompanyLogoHash: (...a: unknown[]) => recordCompanyLogoHash(...(a as [])),
}));

const buildKnownCompanyLogoShaSet = vi.fn(async () => new Set<string>());
vi.mock("@/lib/contacts/known-logos.server", () => ({
  buildKnownCompanyLogoShaSet: (...a: unknown[]) => buildKnownCompanyLogoShaSet(...(a as [])),
}));

const markGoogleContactDirty = vi.fn(async () => {});
vi.mock("@/lib/google-contacts/mark-dirty.server", () => ({
  markGoogleContactDirty: (...a: unknown[]) => markGoogleContactDirty(...(a as [])),
}));

import {
  listContactsForLogoCleanup,
  cleanupCompanyLogoPhotosBatch,
  resetContactToCompanyLogo,
} from "./company-logo-cleanup.functions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "company-1";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = {};
const asAttacker = { userId: ATTACKER };

function seedContact(over: Parameters<typeof makeContactRow>[0] = {}) {
  return makeContactRow({
    id: CONTACT_ID,
    user_id: TEST_USER,
    avatar_url: `${TEST_USER}/avatar.png`,
    company_id: COMPANY_ID,
    ...over,
  });
}

beforeEach(() => {
  fake.reset();
  for (const m of [
    loadContactPhotoBytes,
    deleteContactPhoto,
    sha256Hex,
    fetchChosenCompanyLogoBytes,
    resolveCompanyLogoDomainForContact,
    getCompanyLogoVariantShas,
    getKnownCompanyLogoHashes,
    recordCompanyLogoHash,
    buildKnownCompanyLogoShaSet,
    markGoogleContactDirty,
  ]) {
    m.mockClear();
  }
  loadContactPhotoBytes.mockResolvedValue({ bytes: new Uint8Array([1]), mime: "image/png" });
  sha256Hex.mockResolvedValue("sha-avatar");
  fetchChosenCompanyLogoBytes.mockResolvedValue(null);
  resolveCompanyLogoDomainForContact.mockResolvedValue("acme.com");
  getCompanyLogoVariantShas.mockResolvedValue(new Set());
  getKnownCompanyLogoHashes.mockResolvedValue(new Set());
  buildKnownCompanyLogoShaSet.mockResolvedValue(new Set());
});

describe("cleanupCompanyLogoPhotosBatch", () => {
  it("clears an avatar whose bytes match the contact's current company logo", async () => {
    fake.seed("contacts", [seedContact()]);
    fake.seed("carddav_settings", [{ user_id: TEST_USER, resync_nonce: 3 }]);
    // Avatar bytes and current-logo bytes hash to the same value.
    fetchChosenCompanyLogoBytes.mockResolvedValue({
      bytes: new Uint8Array([1]),
      mime: "image/png",
    });

    const res = (await call(cleanupCompanyLogoPhotosBatch, {
      data: { ids: [CONTACT_ID] },
      context: asUser,
    })) as unknown as { cleared: number; kept: number };
    expect(res).toEqual({ cleared: 1, kept: 0 });
    expect(deleteContactPhoto).toHaveBeenCalledExactlyOnceWith(TEST_USER, CONTACT_ID);
    expect(recordCompanyLogoHash).toHaveBeenCalledExactlyOnceWith({
      userId: TEST_USER,
      companyId: COMPANY_ID,
      domain: "acme.com",
      sha256: "sha-avatar",
      source: "bulk_cleanup",
    });
    // The row is stamped so the CardDAV PUT guard recognises future echoes.
    const stamp = writesTo(fake, "updates", "contacts")[0]!;
    expect(stamp.payload).toStrictEqual({ company_logo_photo_sha: "sha-avatar" });
    expect(stamp.filters).toStrictEqual([
      { op: "eq", col: "id", value: CONTACT_ID, extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
    expect(markGoogleContactDirty).toHaveBeenCalledWith(TEST_USER, CONTACT_ID);
    expect(writesTo(fake, "upserts", "carddav_settings")[0]).toMatchObject({
      payload: { user_id: TEST_USER, resync_nonce: 4 },
      options: { onConflict: "user_id" },
    });
  });

  it("a match on a previously recorded hash is not recorded a second time", async () => {
    fake.seed("contacts", [seedContact()]);
    getKnownCompanyLogoHashes.mockResolvedValue(new Set(["sha-avatar"]));
    const res = (await call(cleanupCompanyLogoPhotosBatch, {
      data: { ids: [CONTACT_ID] },
      context: asUser,
    })) as unknown as { cleared: number };
    expect(res.cleared).toBe(1);
    expect(recordCompanyLogoHash).not.toHaveBeenCalled();
    expect(deleteContactPhoto).toHaveBeenCalledOnce();
  });

  it("a match against a provider variant of the company's logo also clears", async () => {
    fake.seed("contacts", [seedContact()]);
    getCompanyLogoVariantShas.mockResolvedValue(new Set(["sha-avatar"]));
    const res = (await call(cleanupCompanyLogoPhotosBatch, {
      data: { ids: [CONTACT_ID] },
      context: asUser,
    })) as unknown as { cleared: number };
    expect(res.cleared).toBe(1);
    expect(getCompanyLogoVariantShas).toHaveBeenCalledWith(
      TEST_USER,
      COMPANY_ID,
      expect.any(Function),
    );
  });

  it("an avatar that matches nothing is left completely alone", async () => {
    fake.seed("contacts", [seedContact()]);
    fetchChosenCompanyLogoBytes.mockResolvedValue({
      bytes: new Uint8Array([9]),
      mime: "image/png",
    });
    sha256Hex.mockImplementation(async (bytes: unknown) =>
      (bytes as Uint8Array)[0] === 1 ? "sha-avatar" : "sha-logo",
    );

    const res = (await call(cleanupCompanyLogoPhotosBatch, {
      data: { ids: [CONTACT_ID] },
      context: asUser,
    })) as unknown as { cleared: number; kept: number };
    expect(res).toEqual({ cleared: 0, kept: 1 });
    expect(deleteContactPhoto).not.toHaveBeenCalled();
    expect(recordCompanyLogoHash).not.toHaveBeenCalled();
    // No nonce bump either — nothing changed for iOS to re-pull.
    expect(writeCount(fake)).toBe(0);
  });

  it("a contact with no avatar or no linked company is kept without a byte fetch", async () => {
    fake.seed("contacts", [
      seedContact({ avatar_url: null }),
      seedContact({ id: OTHER_ID, company_id: null }),
    ]);
    const res = (await call(cleanupCompanyLogoPhotosBatch, {
      data: { ids: [CONTACT_ID, OTHER_ID] },
      context: asUser,
    })) as unknown as { cleared: number; kept: number };
    expect(res).toEqual({ cleared: 0, kept: 2 });
    expect(loadContactPhotoBytes).not.toHaveBeenCalled();
  });

  it("ids belonging to another tenant are filtered out of the batch", async () => {
    fake.seed("contacts", [seedContact({ id: OTHER_ID, user_id: VICTIM })]);
    const res = (await call(cleanupCompanyLogoPhotosBatch, {
      data: { ids: [OTHER_ID] },
      context: asAttacker,
    })) as unknown as { cleared: number; kept: number };
    expect(res).toEqual({ cleared: 0, kept: 0 });
    expect(loadContactPhotoBytes).not.toHaveBeenCalled();
    expect(deleteContactPhoto).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
    expect(fake.calls.selects[0]!.filters).toStrictEqual([
      { op: "in", col: "id", value: [OTHER_ID], extra: undefined },
      { op: "eq", col: "user_id", value: ATTACKER, extra: undefined },
    ]);
  });

  it("a failing contacts read aborts before any photo is touched", async () => {
    fake.onSelect("contacts", () => ({ message: "statement timeout" }));
    await expect(
      call(cleanupCompanyLogoPhotosBatch, { data: { ids: [CONTACT_ID] }, context: asUser }),
    ).rejects.toThrow("statement timeout");
    expect(deleteContactPhoto).not.toHaveBeenCalled();
  });

  it("zod rejects an empty batch and a batch over the cap", async () => {
    await expect(cleanupCompanyLogoPhotosBatch({ data: { ids: [] } })).rejects.toThrow();
    await expect(
      cleanupCompanyLogoPhotosBatch({
        data: { ids: Array.from({ length: 21 }, () => CONTACT_ID) },
      }),
    ).rejects.toThrow();
    expect(deleteContactPhoto).not.toHaveBeenCalled();
  });
});

describe("resetContactToCompanyLogo", () => {
  it("refuses a contact with no linked company before deleting its photo", async () => {
    fake.seed("contacts", [seedContact({ company_id: null })]);
    await expect(
      call(resetContactToCompanyLogo, { data: { contactId: CONTACT_ID }, context: asUser }),
    ).rejects.toThrow("Contact has no linked company");
    expect(deleteContactPhoto).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses another tenant's contact with zero writes", async () => {
    fake.seed("contacts", [seedContact({ user_id: VICTIM })]);
    await expect(
      call(resetContactToCompanyLogo, { data: { contactId: CONTACT_ID }, context: asAttacker }),
    ).rejects.toThrow("Contact not found");
    expect(deleteContactPhoto).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("clears the avatar, stamps the live logo sha and bumps the resync nonce", async () => {
    fake.seed("contacts", [seedContact()]);
    fetchChosenCompanyLogoBytes.mockResolvedValue({
      bytes: new Uint8Array([7]),
      mime: "image/png",
    });
    sha256Hex.mockResolvedValue("sha-logo");

    const res = await call(resetContactToCompanyLogo, {
      data: { contactId: CONTACT_ID },
      context: asUser,
    });
    expect(res).toEqual({ ok: true });
    expect(deleteContactPhoto).toHaveBeenCalledExactlyOnceWith(TEST_USER, CONTACT_ID);
    expect(writesTo(fake, "updates", "contacts")[0]!.payload).toStrictEqual({
      company_logo_photo_sha: "sha-logo",
    });
    expect(writesTo(fake, "upserts", "carddav_settings")[0]).toMatchObject({
      payload: { user_id: TEST_USER, resync_nonce: 1 },
    });
    expect(markGoogleContactDirty).toHaveBeenCalledWith(TEST_USER, CONTACT_ID);
  });

  it("a contact with no avatar still re-stamps and bumps, without a photo delete", async () => {
    fake.seed("contacts", [seedContact({ avatar_url: null })]);
    fetchChosenCompanyLogoBytes.mockResolvedValue({
      bytes: new Uint8Array([7]),
      mime: "image/png",
    });
    await call(resetContactToCompanyLogo, { data: { contactId: CONTACT_ID }, context: asUser });
    expect(deleteContactPhoto).not.toHaveBeenCalled();
    expect(writesTo(fake, "upserts", "carddav_settings")).toHaveLength(1);
  });

  it("a provider that cannot supply the logo leaves the sha stamp alone", async () => {
    fake.seed("contacts", [seedContact()]);
    fetchChosenCompanyLogoBytes.mockResolvedValue(null);
    await call(resetContactToCompanyLogo, { data: { contactId: CONTACT_ID }, context: asUser });
    expect(writesTo(fake, "updates", "contacts")).toHaveLength(0);
  });
});

describe("listContactsForLogoCleanup", () => {
  it("lists only the caller's contacts that have both an avatar and a company", async () => {
    fake.seed("contacts", [
      seedContact({ created_at: "2026-01-01T00:00:00Z" }),
      seedContact({ id: "no-avatar", avatar_url: null }),
      seedContact({ id: "no-company", company_id: null }),
      seedContact({ id: "foreign", user_id: VICTIM }),
    ]);
    const res = (await call(listContactsForLogoCleanup, {
      data: {},
      context: asUser,
    })) as unknown as { ids: string[] };
    expect(res.ids).toStrictEqual([CONTACT_ID]);
  });

  it("a failing read surfaces to the caller", async () => {
    fake.onSelect("contacts", () => ({ message: "statement timeout" }));
    await expect(call(listContactsForLogoCleanup, { data: {}, context: asUser })).rejects.toThrow(
      "statement timeout",
    );
  });
});
