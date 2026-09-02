// src/lib/companies/company-photo.functions.ts — the two server fns behind a
// company's custom uploaded logo. Both take a client-supplied company id and
// are guarded by `assertOwnsCompany`, which reads through the service-role
// client, so cross-tenant denial is unit-testable.
//
// The storage side (`company-photo.server`) is stubbed: this file is about the
// guard, the size/shape validation and the best-effort fan-out afterwards.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { expectDeniedCrossUser } from "@/lib/__fixtures__/idor";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const saveCompanyPhoto = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ logoUrl: string; sha: string }>>(),
);
const deleteCompanyPhoto = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("./company-photo.server", () => ({
  saveCompanyPhoto: (...args: unknown[]) => saveCompanyPhoto(...args),
  deleteCompanyPhoto: (...args: unknown[]) => deleteCompanyPhoto(...args),
}));

const bumpResyncNonce = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("@/lib/carddav/settings.functions", () => ({
  bumpResyncNonce: (...args: unknown[]) => bumpResyncNonce(...args),
}));

const markGoogleContactsDirty = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
const markGooglePhotoDirtyMany = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("@/lib/google-contacts/mark-dirty.server", () => ({
  markGoogleContactsDirty: (...args: unknown[]) => markGoogleContactsDirty(...args),
  markGooglePhotoDirtyMany: (...args: unknown[]) => markGooglePhotoDirtyMany(...args),
}));

import { uploadCompanyPhoto, removeCompanyPhoto } from "./company-photo.functions";

const USER = TEST_USER;
const ATTACKER = "attacker-user-9";
const VICTIM = "victim-user-7";
const COMPANY = "aaaaaaaa-1111-4111-8111-111111111111";

const ctx = { context: { supabase: fake.supabaseAdmin } };
const asAttacker = { context: { supabase: fake.supabaseAdmin, userId: ATTACKER } };

/** base64 for the four bytes 0x01 0x02 0x03 0x04. */
const FOUR_BYTES = "AQIDBA==";

beforeEach(() => {
  fake.reset();
  saveCompanyPhoto.mockResolvedValue({ logoUrl: "https://cdn.test/logo.png", sha: "sha-1" });
  deleteCompanyPhoto.mockResolvedValue(undefined);
  bumpResyncNonce.mockResolvedValue(undefined);
  markGoogleContactsDirty.mockResolvedValue(undefined);
  markGooglePhotoDirtyMany.mockResolvedValue(undefined);
});

describe("uploadCompanyPhoto", () => {
  it("denies a cross-user company id and never reaches storage", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: VICTIM, name: "Victim Co" }]);

    await expectDeniedCrossUser({
      fake,
      call: () =>
        uploadCompanyPhoto({
          data: { companyId: COMPANY, base64: FOUR_BYTES, mime: "image/png" },
          ...asAttacker,
        }),
      rejects: "Company not found",
    });
    expect(saveCompanyPhoto).not.toHaveBeenCalled();
  });

  it("surfaces a lookup failure rather than reporting a missing company", async () => {
    fake.onSelect("companies", () => ({ message: "policy error" }));

    await expect(
      uploadCompanyPhoto({
        data: { companyId: COMPANY, base64: FOUR_BYTES, mime: "image/png" },
        ...ctx,
      }),
    ).rejects.toThrow("Company lookup failed: policy error");
    expect(saveCompanyPhoto).not.toHaveBeenCalled();
  });

  it("rejects a malformed base64 payload after the ownership check", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);

    await expect(
      uploadCompanyPhoto({
        data: { companyId: COMPANY, base64: "!!!", mime: "image/png" },
        ...ctx,
      }),
    ).rejects.toThrow();
    expect(fake.calls.selects.map((sel) => sel.table)).toStrictEqual(["companies"]);
    expect(saveCompanyPhoto).not.toHaveBeenCalled();
  });

  it("rejects an image over the 5 MB cap", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    // 5 MB + 3 bytes of base64-encoded zeros.
    const tooBig = btoa("\0".repeat(5 * 1024 * 1024 + 3));

    await expect(
      uploadCompanyPhoto({
        data: { companyId: COMPANY, base64: tooBig, mime: "image/png" },
        ...ctx,
      }),
    ).rejects.toThrow("Image too large (max 5 MB)");
    expect(saveCompanyPhoto).not.toHaveBeenCalled();
  });

  it("saves the decoded bytes, bumps the resync nonce and marks the members dirty", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.seed("contacts", [
      { id: "k1", user_id: USER, company_id: COMPANY },
      { id: "k2", user_id: USER, company_id: COMPANY },
      { id: "other", user_id: USER, company_id: null },
      { id: "foreign", user_id: VICTIM, company_id: COMPANY },
    ]);

    const res = await uploadCompanyPhoto({
      data: { companyId: COMPANY, base64: FOUR_BYTES, mime: "image/png" },
      ...ctx,
    });

    expect(res).toStrictEqual({ logoUrl: "https://cdn.test/logo.png" });
    expect(saveCompanyPhoto).toHaveBeenCalledWith(
      USER,
      COMPANY,
      new Uint8Array([1, 2, 3, 4]),
      "image/png",
    );
    expect(bumpResyncNonce).toHaveBeenCalledWith(fake.supabaseAdmin, USER);
    expect(markGoogleContactsDirty).toHaveBeenCalledWith(USER, ["k1", "k2"]);
    expect(markGooglePhotoDirtyMany).toHaveBeenCalledWith(USER, ["k1", "k2"]);
    // The fn itself writes nothing — storage and the dirty markers own that.
    expect(writeCount(fake)).toBe(0);
  });

  it("still returns the URL when the resync bump and the Google fan-out fail", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    bumpResyncNonce.mockRejectedValue(new Error("nonce boom"));
    markGoogleContactsDirty.mockRejectedValue(new Error("not linked to google"));

    await expect(
      uploadCompanyPhoto({
        data: { companyId: COMPANY, base64: FOUR_BYTES, mime: "image/png" },
        ...ctx,
      }),
    ).resolves.toStrictEqual({ logoUrl: "https://cdn.test/logo.png" });
  });

  it("rejects a mime type outside the allowed image set", async () => {
    await expect(
      uploadCompanyPhoto({
        data: { companyId: COMPANY, base64: FOUR_BYTES, mime: "image/svg+xml" },
        ...ctx,
      }),
    ).rejects.toThrow();
    expect(fake.calls.selects).toHaveLength(0);
  });
});

describe("removeCompanyPhoto", () => {
  it("denies a cross-user company id and never deletes anything", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: VICTIM, name: "Victim Co" }]);

    await expectDeniedCrossUser({
      fake,
      call: () => removeCompanyPhoto({ data: { companyId: COMPANY }, ...asAttacker }),
      rejects: "Company not found",
    });
    expect(deleteCompanyPhoto).not.toHaveBeenCalled();
  });

  it("deletes the logo, bumps the nonce and marks the members dirty", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    fake.seed("contacts", [{ id: "k1", user_id: USER, company_id: COMPANY }]);

    const res = await removeCompanyPhoto({ data: { companyId: COMPANY }, ...ctx });

    expect(res).toStrictEqual({ ok: true });
    expect(deleteCompanyPhoto).toHaveBeenCalledWith(USER, COMPANY);
    expect(bumpResyncNonce).toHaveBeenCalledWith(fake.supabaseAdmin, USER);
    expect(markGooglePhotoDirtyMany).toHaveBeenCalledWith(USER, ["k1"]);
  });

  it("propagates a storage deletion failure", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme" }]);
    deleteCompanyPhoto.mockRejectedValue(new Error("storage boom"));

    await expect(removeCompanyPhoto({ data: { companyId: COMPANY }, ...ctx })).rejects.toThrow(
      "storage boom",
    );
    expect(bumpResyncNonce).not.toHaveBeenCalled();
  });
});
