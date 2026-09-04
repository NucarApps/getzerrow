// Custom company-logo storage (company-photo.server.ts). This module owns a
// PUBLIC bucket and a cache other code trusts, so the contracts pinned here
// are the ones whose failure is invisible until a user's avatar is wrong:
//
//   * every DB read and write is filtered by BOTH id and user_id — the
//     admin client bypasses RLS, so a dropped user_id predicate is a
//     cross-tenant logo overwrite,
//   * the object key is `{userId}/{companyId}-{hash}.{ext}`, which is what
//     keeps one user's upload out of another's prefix and makes a re-upload
//     of identical bytes idempotent,
//   * size limits are enforced BEFORE hashing or uploading,
//   * the previous object is pruned only after the new URL is committed,
//     and never when the key is unchanged (that would delete what was just
//     written),
//   * the upload is fingerprinted into company_logo_hashes and the known-SHA
//     cache is invalidated — skipping that lets the pull guard promote a
//     brand-new company logo into a member's personal avatar for up to five
//     minutes,
//   * a failed upload or update aborts before the DB/storage is left half
//     updated.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const recordCompanyLogoHash = vi.fn(async () => {});
vi.mock("@/lib/contacts/logo-photo.server", () => ({
  recordCompanyLogoHash: (...a: unknown[]) => recordCompanyLogoHash(...(a as [])),
}));

const invalidateKnownCompanyLogoShaCache = vi.fn();
vi.mock("@/lib/contacts/known-logos.server", () => ({
  invalidateKnownCompanyLogoShaCache: (...a: unknown[]) =>
    invalidateKnownCompanyLogoShaCache(...(a as [])),
}));

const { saveCompanyPhoto, deleteCompanyPhoto, loadCompanyPhotoBytes, COMPANY_LOGO_BUCKET } =
  await import("./company-photo.server");
const { MAX_STORED_PHOTO_BYTES } = await import("@/lib/photo-storage.server");

const USER = "user-1";
const COMPANY = "company-1";
const BYTES = new Uint8Array([1, 2, 3, 4]);

/** The key `saveCompanyPhoto` computes for BYTES — read back off the
 * recorded upload rather than recomputed, so the hash stays the code's. */
function uploadedKey(): string {
  const up = fake.calls.storage.find((c) => c.method === "upload");
  return up?.args[0] as string;
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
});

describe("saveCompanyPhoto", () => {
  it("rejects empty bytes and oversize bytes before touching storage", async () => {
    await expect(saveCompanyPhoto(USER, COMPANY, new Uint8Array(0), "image/png")).rejects.toThrow(
      "Empty photo bytes",
    );
    await expect(
      saveCompanyPhoto(USER, COMPANY, new Uint8Array(MAX_STORED_PHOTO_BYTES + 1), "image/png"),
    ).rejects.toThrow("Photo too large");
    expect(fake.calls.storage).toEqual([]);
    expect(fake.calls.selects).toEqual([]);
  });

  it("uploads under the user's own prefix and commits the public URL", async () => {
    const res = await saveCompanyPhoto(USER, COMPANY, BYTES, "image/png");

    const key = uploadedKey();
    expect(key).toMatch(new RegExp(`^${USER}/${COMPANY}-[0-9a-f]+\\.png$`));
    expect(fake.calls.storage[0]).toMatchObject({
      bucket: COMPANY_LOGO_BUCKET,
      method: "upload",
    });
    expect(fake.calls.storage[0]?.args[2]).toMatchObject({
      contentType: "image/png",
      upsert: true,
    });
    expect(res.logoUrl).toBe(`https://storage.test/${COMPANY_LOGO_BUCKET}/${key}`);
    expect(fake.calls.updates[0]).toMatchObject({
      table: "companies",
      payload: { logo_url: res.logoUrl },
      filters: [
        { op: "eq", col: "id", value: COMPANY },
        { op: "eq", col: "user_id", value: USER },
      ],
    });
  });

  it("scopes the previous-logo read to the caller", async () => {
    await saveCompanyPhoto(USER, COMPANY, BYTES, "image/png");
    expect(fake.calls.selects[0]).toMatchObject({
      table: "companies",
      filters: [
        { op: "eq", col: "id", value: COMPANY },
        { op: "eq", col: "user_id", value: USER },
      ],
    });
  });

  it("defaults a blank mime to jpeg for the stored content type", async () => {
    await saveCompanyPhoto(USER, COMPANY, BYTES, "");
    expect(fake.calls.storage[0]?.args[2]).toMatchObject({ contentType: "image/jpeg" });
  });

  it("prunes the previous object once the new URL is committed", async () => {
    fake.seedRaw("companies", [
      {
        id: COMPANY,
        user_id: USER,
        logo_url: `https://storage.test/${COMPANY_LOGO_BUCKET}/${USER}/${COMPANY}-old.png`,
      },
    ]);

    await saveCompanyPhoto(USER, COMPANY, BYTES, "image/png");

    const removes = fake.calls.storage.filter((c) => c.method === "remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]?.args[0]).toEqual([`${USER}/${COMPANY}-old.png`]);
    // …and only after the DB pointed at the replacement.
    expect(fake.calls.updates).toHaveLength(1);
  });

  it("does not prune when re-uploading identical bytes", async () => {
    // First upload to learn the key the content hash produces.
    await saveCompanyPhoto(USER, COMPANY, BYTES, "image/png");
    const key = uploadedKey();
    fake.reset();
    fake.seedRaw("companies", [
      {
        id: COMPANY,
        user_id: USER,
        logo_url: `https://storage.test/${COMPANY_LOGO_BUCKET}/${key}`,
      },
    ]);

    await saveCompanyPhoto(USER, COMPANY, BYTES, "image/png");

    // Removing here would delete the object just written.
    expect(fake.calls.storage.filter((c) => c.method === "remove")).toEqual([]);
  });

  it("leaves a foreign logo URL alone rather than trying to delete it", async () => {
    fake.seedRaw("companies", [
      { id: COMPANY, user_id: USER, logo_url: "https://cdn.example.com/brand/acme.png" },
    ]);
    await saveCompanyPhoto(USER, COMPANY, BYTES, "image/png");
    expect(fake.calls.storage.filter((c) => c.method === "remove")).toEqual([]);
  });

  it("fingerprints the upload and invalidates the known-logo cache", async () => {
    const res = await saveCompanyPhoto(USER, COMPANY, BYTES, "image/png");

    expect(recordCompanyLogoHash).toHaveBeenCalledWith({
      userId: USER,
      companyId: COMPANY,
      domain: null,
      sha256: res.sha,
      source: "custom_upload",
    });
    expect(res.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(invalidateKnownCompanyLogoShaCache).toHaveBeenCalledWith(USER);
  });

  it("aborts on an upload error without committing a URL", async () => {
    fake.onStorage(COMPANY_LOGO_BUCKET, "upload", () => ({ error: { message: "upload failed" } }));
    await expect(saveCompanyPhoto(USER, COMPANY, BYTES, "image/png")).rejects.toThrow(
      "upload failed",
    );
    expect(fake.calls.updates).toEqual([]);
    expect(recordCompanyLogoHash).not.toHaveBeenCalled();
  });

  it("aborts on an update error without fingerprinting the logo", async () => {
    fake.onUpdate("companies", () => ({ message: "update failed" }));
    await expect(saveCompanyPhoto(USER, COMPANY, BYTES, "image/png")).rejects.toThrow(
      "update failed",
    );
    expect(recordCompanyLogoHash).not.toHaveBeenCalled();
    expect(invalidateKnownCompanyLogoShaCache).not.toHaveBeenCalled();
  });
});

describe("deleteCompanyPhoto", () => {
  it("removes the object and clears the column, both scoped to the caller", async () => {
    fake.seedRaw("companies", [
      {
        id: COMPANY,
        user_id: USER,
        logo_url: `https://storage.test/${COMPANY_LOGO_BUCKET}/${USER}/${COMPANY}-x.png`,
      },
    ]);

    await deleteCompanyPhoto(USER, COMPANY);

    expect(fake.calls.storage[0]).toMatchObject({
      bucket: COMPANY_LOGO_BUCKET,
      method: "remove",
      args: [[`${USER}/${COMPANY}-x.png`]],
    });
    expect(fake.calls.updates[0]).toMatchObject({
      payload: { logo_url: null },
      filters: [
        { op: "eq", col: "id", value: COMPANY },
        { op: "eq", col: "user_id", value: USER },
      ],
    });
  });

  it("still clears the column when there is no object of ours to remove", async () => {
    fake.seedRaw("companies", [
      { id: COMPANY, user_id: USER, logo_url: "https://cdn.example.com/brand/acme.png" },
    ]);
    await deleteCompanyPhoto(USER, COMPANY);
    expect(fake.calls.storage).toEqual([]);
    expect(fake.calls.updates[0]).toMatchObject({ payload: { logo_url: null } });
  });

  it("throws when the column could not be cleared", async () => {
    fake.onUpdate("companies", () => ({ message: "clear failed" }));
    await expect(deleteCompanyPhoto(USER, COMPANY)).rejects.toThrow("clear failed");
  });
});

describe("loadCompanyPhotoBytes", () => {
  it("returns null for a null URL and for one outside our bucket", async () => {
    expect(await loadCompanyPhotoBytes(null)).toBeNull();
    expect(await loadCompanyPhotoBytes("https://cdn.example.com/brand/acme.png")).toBeNull();
    expect(fake.calls.storage).toEqual([]);
  });

  it("downloads the object and reports its mime", async () => {
    fake.onStorage(COMPANY_LOGO_BUCKET, "download", () => ({
      data: new Blob([BYTES], { type: "image/webp" }),
    }));
    const res = await loadCompanyPhotoBytes(
      `https://storage.test/${COMPANY_LOGO_BUCKET}/${USER}/${COMPANY}-x.webp`,
    );
    expect(res?.mime).toBe("image/webp");
    expect(Array.from(res!.bytes)).toEqual([1, 2, 3, 4]);
    expect(fake.calls.storage[0]?.args[0]).toBe(`${USER}/${COMPANY}-x.webp`);
  });

  it("falls back to jpeg when the stored blob carries no type", async () => {
    fake.onStorage(COMPANY_LOGO_BUCKET, "download", () => ({ data: new Blob([BYTES]) }));
    const res = await loadCompanyPhotoBytes(
      `https://storage.test/${COMPANY_LOGO_BUCKET}/${USER}/x.bin`,
    );
    expect(res?.mime).toBe("image/jpeg");
  });

  it("returns null rather than throwing when the download fails", async () => {
    fake.onStorage(COMPANY_LOGO_BUCKET, "download", () => ({ error: { message: "gone" } }));
    expect(
      await loadCompanyPhotoBytes(`https://storage.test/${COMPANY_LOGO_BUCKET}/${USER}/x.png`),
    ).toBeNull();
  });
});
