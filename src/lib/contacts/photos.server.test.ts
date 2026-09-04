// Contact avatar storage (photos.server.ts). The company-logo sibling of
// this module is covered in companies/company-photo.server.test.ts; the
// contracts here are the same shape but carry two extra ones of their own:
//
//   * saving a real photo CLEARS company_logo_photo_sha. That column is
//     what marks an avatar as "this is really the company's logo, don't
//     treat it as a personal photo" — leaving it set after a genuine
//     upload makes the echo guard discard the user's own picture,
//   * avatar_source records where the bytes came from, and the sync code
//     branches on it, so it is written through rather than defaulted away.
//
// Plus the shared ones: both id and user_id filter every read and write
// (the admin client bypasses RLS), the key is `{userId}/{contactId}-{hash}`
// so bytes changing bumps the URL and busts the CDN cache, size limits are
// checked before hashing, and the previous object is pruned only after the
// new URL is committed and never when the key is unchanged.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const {
  saveContactPhoto,
  deleteContactPhoto,
  loadContactPhotoBytes,
  signContactPhotoUrl,
  sha256Hex,
  CONTACT_PHOTO_BUCKET,
} = await import("./photos.server");
const { MAX_STORED_PHOTO_BYTES } = await import("@/lib/photo-storage.server");

const USER = "user-1";
const CONTACT = "contact-1";
const BYTES = new Uint8Array([9, 8, 7]);
const urlFor = (key: string) => `https://storage.test/${CONTACT_PHOTO_BUCKET}/${key}`;

function uploadedKey(): string {
  return fake.calls.storage.find((c) => c.method === "upload")?.args[0] as string;
}

function seedAvatar(url: string | null) {
  fake.seedRaw("contacts", [{ id: CONTACT, user_id: USER, avatar_url: url }]);
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
});

describe("saveContactPhoto", () => {
  it("rejects empty and oversize bytes before touching storage", async () => {
    await expect(saveContactPhoto(USER, CONTACT, new Uint8Array(0), "image/png")).rejects.toThrow(
      "Empty photo bytes",
    );
    await expect(
      saveContactPhoto(USER, CONTACT, new Uint8Array(MAX_STORED_PHOTO_BYTES + 1), "image/png"),
    ).rejects.toThrow("Photo too large");
    expect(fake.calls.storage).toEqual([]);
  });

  it("uploads under the user's prefix with a content-addressed name", async () => {
    const res = await saveContactPhoto(USER, CONTACT, BYTES, "image/png");

    expect(uploadedKey()).toMatch(new RegExp(`^${USER}/${CONTACT}-[0-9a-f]+\\.png$`));
    expect(res.avatarUrl).toBe(urlFor(uploadedKey()));
    // The short hash is what the URL and the delta-sync etag both hang off.
    expect(uploadedKey()).toContain(res.hash);
  });

  it("bumps the key when the bytes change, so the public URL busts caches", async () => {
    await saveContactPhoto(USER, CONTACT, BYTES, "image/png");
    const first = uploadedKey();
    fake.reset();
    await saveContactPhoto(USER, CONTACT, new Uint8Array([1, 1, 1]), "image/png");
    expect(uploadedKey()).not.toBe(first);
  });

  it("records the source and clears the company-logo fingerprint", async () => {
    await saveContactPhoto(USER, CONTACT, BYTES, "image/png", "user_upload");

    expect(fake.calls.updates[0]).toMatchObject({
      table: "contacts",
      payload: {
        avatar_url: urlFor(uploadedKey()),
        avatar_source: "user_upload",
        // Left set, the echo guard would keep treating this genuine upload
        // as a company logo and discard it on the next pull.
        company_logo_photo_sha: null,
      },
      filters: [
        { op: "eq", col: "id", value: CONTACT },
        { op: "eq", col: "user_id", value: USER },
      ],
    });
  });

  it("defaults the source to unknown", async () => {
    await saveContactPhoto(USER, CONTACT, BYTES, "image/png");
    expect(fake.calls.updates[0]?.payload).toMatchObject({ avatar_source: "unknown" });
  });

  it("defaults a blank mime to jpeg", async () => {
    await saveContactPhoto(USER, CONTACT, BYTES, "");
    expect(fake.calls.storage[0]?.args[2]).toMatchObject({ contentType: "image/jpeg" });
  });

  it("scopes the previous-avatar read to the caller", async () => {
    await saveContactPhoto(USER, CONTACT, BYTES, "image/png");
    expect(fake.calls.selects[0]).toMatchObject({
      table: "contacts",
      filters: [
        { op: "eq", col: "id", value: CONTACT },
        { op: "eq", col: "user_id", value: USER },
      ],
    });
  });

  it("prunes the previous object after the new URL is committed", async () => {
    seedAvatar(urlFor(`${USER}/${CONTACT}-old.png`));

    await saveContactPhoto(USER, CONTACT, BYTES, "image/png");

    const removes = fake.calls.storage.filter((c) => c.method === "remove");
    expect(removes[0]?.args[0]).toEqual([`${USER}/${CONTACT}-old.png`]);
    expect(fake.calls.updates).toHaveLength(1);
  });

  it("does not prune when the same bytes are re-uploaded", async () => {
    await saveContactPhoto(USER, CONTACT, BYTES, "image/png");
    const key = uploadedKey();
    fake.reset();
    seedAvatar(urlFor(key));

    await saveContactPhoto(USER, CONTACT, BYTES, "image/png");

    expect(fake.calls.storage.filter((c) => c.method === "remove")).toEqual([]);
  });

  it("leaves a remote avatar URL alone rather than trying to delete it", async () => {
    seedAvatar("https://lh3.googleusercontent.com/a/abc123");
    await saveContactPhoto(USER, CONTACT, BYTES, "image/png");
    expect(fake.calls.storage.filter((c) => c.method === "remove")).toEqual([]);
  });

  it("aborts on an upload error without committing a URL", async () => {
    fake.onStorage(CONTACT_PHOTO_BUCKET, "upload", () => ({ error: { message: "upload failed" } }));
    await expect(saveContactPhoto(USER, CONTACT, BYTES, "image/png")).rejects.toThrow(
      "upload failed",
    );
    expect(fake.calls.updates).toEqual([]);
  });

  it("aborts on an update error without pruning the old object", async () => {
    seedAvatar(urlFor(`${USER}/${CONTACT}-old.png`));
    fake.onUpdate("contacts", () => ({ message: "update failed" }));
    await expect(saveContactPhoto(USER, CONTACT, BYTES, "image/png")).rejects.toThrow(
      "update failed",
    );
    // Pruning here would delete the avatar still referenced by the row.
    expect(fake.calls.storage.filter((c) => c.method === "remove")).toEqual([]);
  });
});

describe("deleteContactPhoto", () => {
  it("removes the object and resets both avatar columns", async () => {
    seedAvatar(urlFor(`${USER}/${CONTACT}-x.png`));

    await deleteContactPhoto(USER, CONTACT);

    expect(fake.calls.storage[0]).toMatchObject({
      method: "remove",
      args: [[`${USER}/${CONTACT}-x.png`]],
    });
    expect(fake.calls.updates[0]).toMatchObject({
      payload: { avatar_url: null, avatar_source: "unknown" },
      filters: [
        { op: "eq", col: "id", value: CONTACT },
        { op: "eq", col: "user_id", value: USER },
      ],
    });
  });

  it("still clears the columns when there is no object of ours to remove", async () => {
    seedAvatar("https://lh3.googleusercontent.com/a/abc123");
    await deleteContactPhoto(USER, CONTACT);
    expect(fake.calls.storage).toEqual([]);
    expect(fake.calls.updates[0]?.payload).toMatchObject({ avatar_url: null });
  });

  it("clears the columns for a contact that never had a photo", async () => {
    seedAvatar(null);
    await deleteContactPhoto(USER, CONTACT);
    expect(fake.calls.updates).toHaveLength(1);
  });
});

describe("loadContactPhotoBytes", () => {
  it("returns null for a null URL and one outside our bucket", async () => {
    expect(await loadContactPhotoBytes(null)).toBeNull();
    expect(await loadContactPhotoBytes("https://lh3.googleusercontent.com/a/abc")).toBeNull();
    expect(fake.calls.storage).toEqual([]);
  });

  it("returns the bytes and mime from storage", async () => {
    fake.onStorage(CONTACT_PHOTO_BUCKET, "download", () => ({
      data: new Blob([BYTES], { type: "image/heic" }),
    }));
    const res = await loadContactPhotoBytes(urlFor(`${USER}/${CONTACT}-x.heic`));
    expect(Array.from(res!.bytes)).toEqual([9, 8, 7]);
    expect(res?.mime).toBe("image/heic");
  });

  it("falls back to jpeg for a typeless blob and null on a download error", async () => {
    fake.onStorage(CONTACT_PHOTO_BUCKET, "download", () => ({ data: new Blob([BYTES]) }));
    expect((await loadContactPhotoBytes(urlFor("k.bin")))?.mime).toBe("image/jpeg");

    fake.onStorage(CONTACT_PHOTO_BUCKET, "download", () => ({ error: { message: "gone" } }));
    expect(await loadContactPhotoBytes(urlFor("k.bin"))).toBeNull();
  });
});

describe("signContactPhotoUrl", () => {
  it("signs the caller's own contact photo for an hour", async () => {
    seedAvatar(urlFor(`${USER}/${CONTACT}-x.png`));
    fake.onStorage(CONTACT_PHOTO_BUCKET, "createSignedUrl", () => ({
      data: { signedUrl: "https://signed.test/x" },
    }));

    expect(await signContactPhotoUrl(USER, CONTACT)).toBe("https://signed.test/x");
    expect(fake.calls.storage[0]).toMatchObject({
      method: "createSignedUrl",
      args: [`${USER}/${CONTACT}-x.png`, 3600],
    });
  });

  it("returns null for a contact the caller does not own", async () => {
    fake.seedRaw("contacts", [
      { id: CONTACT, user_id: "someone-else", avatar_url: urlFor("victim/photo.png") },
    ]);
    // The user_id predicate is the guard: without a row there is no key to
    // sign, so no URL to a stranger's photo is ever minted.
    expect(await signContactPhotoUrl(USER, CONTACT)).toBeNull();
    expect(fake.calls.storage).toEqual([]);
  });

  it("returns null when there is no photo, a remote one, or signing fails", async () => {
    seedAvatar(null);
    expect(await signContactPhotoUrl(USER, CONTACT)).toBeNull();

    fake.reset();
    seedAvatar("https://lh3.googleusercontent.com/a/abc");
    expect(await signContactPhotoUrl(USER, CONTACT)).toBeNull();

    fake.reset();
    seedAvatar(urlFor("k.png"));
    fake.onStorage(CONTACT_PHOTO_BUCKET, "createSignedUrl", () => ({
      error: { message: "sign failed" },
    }));
    expect(await signContactPhotoUrl(USER, CONTACT)).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("returns the standard hex digest", async () => {
    // Known vector: SHA-256 of the empty input.
    expect(await sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("digests only the view's own window of a shared buffer", async () => {
    // Contact bytes routinely arrive as a subarray of a larger read buffer;
    // hashing the whole backing store would fingerprint the wrong photo.
    const backing = new Uint8Array([0, 0, 9, 8, 7, 0, 0]);
    const view = backing.subarray(2, 5);
    expect(await sha256Hex(view)).toBe(await sha256Hex(BYTES));
  });
});
