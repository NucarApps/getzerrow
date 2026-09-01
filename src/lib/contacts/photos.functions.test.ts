// Contact-photo server fns (photos.functions.ts). Contracts protected:
//
//   * every fn runs assertOwnsContact BEFORE any work — a cross-tenant
//     contactId is rejected with zero writes and zero storage calls (the
//     exemplar for the app-level-guard IDOR sweep; helper:
//     __fixtures__/idor.ts),
//   * upload validates AFTER ownership: empty payload and >5MB payload are
//     rejected without reaching storage,
//   * zod rejects a non-uuid contactId and a non-allowlisted MIME type,
//   * a successful upload/remove marks the linked Google contact dirty and
//     bumps the CardDAV resync nonce — and failures of those side-nudges
//     are non-fatal by design.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

const saveContactPhoto = vi.fn(async () => ({ avatarUrl: "/photos/c-1.jpg" }));
const deleteContactPhoto = vi.fn(async () => {});
const signContactPhotoUrl = vi.fn(async () => "https://signed.example/url");
vi.mock("@/lib/contacts/photos.server", () => ({
  saveContactPhoto: (...a: unknown[]) => saveContactPhoto(...(a as [])),
  deleteContactPhoto: (...a: unknown[]) => deleteContactPhoto(...(a as [])),
  signContactPhotoUrl: (...a: unknown[]) => signContactPhotoUrl(...(a as [])),
}));

const markGoogleContactDirty = vi.fn(async () => {});
const markGooglePhotoDirty = vi.fn(async () => {});
vi.mock("@/lib/google-contacts/mark-dirty.server", () => ({
  markGoogleContactDirty: (...a: unknown[]) => markGoogleContactDirty(...(a as [])),
  markGooglePhotoDirty: (...a: unknown[]) => markGooglePhotoDirty(...(a as [])),
}));

const bumpResyncNonce = vi.fn(async () => {});
vi.mock("@/lib/carddav/settings.functions", () => ({
  bumpResyncNonce: (...a: unknown[]) => bumpResyncNonce(...(a as [])),
}));
vi.mock("@/lib/log.server", () => ({ logInfo: () => {}, logError: () => {} }));

import {
  uploadContactPhoto,
  removeContactPhoto,
  getContactPhotoSignedUrl,
} from "./photos.functions";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const ATTACKER = "attacker-user-9";
// btoa("img-bytes") — a small valid payload.
const SMALL_B64 = btoa("img-bytes");

beforeEach(() => {
  fake.reset();
  saveContactPhoto.mockClear();
  deleteContactPhoto.mockClear();
  signContactPhotoUrl.mockClear();
  markGoogleContactDirty.mockClear();
  markGooglePhotoDirty.mockClear();
  bumpResyncNonce.mockClear();
  // The contact belongs to the default test user.
  fake.seed("contacts", [{ id: CONTACT_ID, user_id: TEST_USER }]);
});

describe("uploadContactPhoto", () => {
  it("owner: saves the photo, marks Google dirty, bumps the CardDAV nonce", async () => {
    const res = await uploadContactPhoto({
      data: { contactId: CONTACT_ID, base64: SMALL_B64, mime: "image/jpeg" },
    });
    expect(res).toEqual({ avatarUrl: "/photos/c-1.jpg" });
    expect(saveContactPhoto).toHaveBeenCalledWith(
      TEST_USER,
      CONTACT_ID,
      expect.any(Uint8Array),
      "image/jpeg",
      "user_upload",
    );
    expect(markGoogleContactDirty).toHaveBeenCalledWith(TEST_USER, CONTACT_ID);
    expect(markGooglePhotoDirty).toHaveBeenCalledWith(TEST_USER, CONTACT_ID);
    expect(bumpResyncNonce).toHaveBeenCalled();
  });

  it("IDOR: another user's contactId is rejected before any storage or write", async () => {
    await expectDeniedCrossUser({
      fake,
      rejects: "Contact not found",
      call: () =>
        impersonate(
          uploadContactPhoto,
          ATTACKER,
        )({
          data: { contactId: CONTACT_ID, base64: SMALL_B64, mime: "image/png" },
        }),
    });
    expect(saveContactPhoto).not.toHaveBeenCalled();
    expect(markGoogleContactDirty).not.toHaveBeenCalled();
  });

  it("rejects an empty decoded payload without reaching storage", async () => {
    await expect(
      uploadContactPhoto({ data: { contactId: CONTACT_ID, base64: "", mime: "image/png" } }),
    ).rejects.toThrow(); // zod: base64 min(1)
    await expect(
      // A lone space passes zod's min(1) but atob ignores whitespace, so it
      // decodes to zero bytes — the only way to reach the byte-level check.
      uploadContactPhoto({
        data: { contactId: CONTACT_ID, base64: " ", mime: "image/png" },
      }),
    ).rejects.toThrow("Empty upload");
    expect(saveContactPhoto).not.toHaveBeenCalled();
  });

  it("rejects a payload over MAX_UPLOAD_BYTES without reaching storage", async () => {
    // 5MB + 1 byte of zeros, base64-encoded in chunks to keep memory sane.
    const bytes = new Uint8Array(5 * 1024 * 1024 + 1);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const big = btoa(bin);
    await expect(
      uploadContactPhoto({ data: { contactId: CONTACT_ID, base64: big, mime: "image/png" } }),
    ).rejects.toThrow("Image too large (max 5 MB)");
    expect(saveContactPhoto).not.toHaveBeenCalled();
  });

  it("zod rejects a non-uuid contactId and a non-allowlisted MIME", async () => {
    await expect(
      uploadContactPhoto({
        data: { contactId: "not-a-uuid", base64: SMALL_B64, mime: "image/png" },
      }),
    ).rejects.toThrow();
    await expect(
      uploadContactPhoto({
        data: { contactId: CONTACT_ID, base64: SMALL_B64, mime: "image/svg+xml" },
      }),
    ).rejects.toThrow();
    expect(saveContactPhoto).not.toHaveBeenCalled();
  });
});

describe("removeContactPhoto", () => {
  it("owner: deletes the stored photo and nudges Google + CardDAV", async () => {
    const res = await removeContactPhoto({ data: { contactId: CONTACT_ID } });
    expect(res).toEqual({ ok: true });
    expect(deleteContactPhoto).toHaveBeenCalledWith(TEST_USER, CONTACT_ID);
    expect(markGooglePhotoDirty).toHaveBeenCalledWith(TEST_USER, CONTACT_ID);
    expect(bumpResyncNonce).toHaveBeenCalled();
  });

  it("IDOR: another user's contactId is rejected with zero writes", async () => {
    await expectDeniedCrossUser({
      fake,
      rejects: "Contact not found",
      call: () => impersonate(removeContactPhoto, ATTACKER)({ data: { contactId: CONTACT_ID } }),
    });
    expect(deleteContactPhoto).not.toHaveBeenCalled();
  });

  it("a failing Google-dirty nudge is non-fatal — removal still succeeds", async () => {
    markGoogleContactDirty.mockRejectedValueOnce(new Error("not linked"));
    const res = await removeContactPhoto({ data: { contactId: CONTACT_ID } });
    expect(res).toEqual({ ok: true });
    expect(deleteContactPhoto).toHaveBeenCalled();
  });
});

describe("getContactPhotoSignedUrl", () => {
  it("owner: returns the signed URL", async () => {
    await expect(getContactPhotoSignedUrl({ data: { contactId: CONTACT_ID } })).resolves.toEqual({
      url: "https://signed.example/url",
    });
  });

  it("IDOR: another user's contactId never reaches the signer", async () => {
    await expectDeniedCrossUser({
      fake,
      rejects: "Contact not found",
      call: () =>
        impersonate(getContactPhotoSignedUrl, ATTACKER)({ data: { contactId: CONTACT_ID } }),
    });
    expect(signContactPhotoUrl).not.toHaveBeenCalled();
  });
});
