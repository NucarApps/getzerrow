import { describe, expect, it } from "vitest";
import {
  isLocalGoogleContactDirty,
  isGooglePhotoPushDirty,
  MAX_PHOTO_PUSH_ATTEMPTS,
} from "./dirty";

describe("isLocalGoogleContactDirty", () => {
  it("treats unsynced linked contacts as dirty", () => {
    expect(isLocalGoogleContactDirty("2026-07-18T12:00:00.000Z", null)).toBe(true);
  });

  it("treats contacts updated after the last Google sync as dirty", () => {
    expect(isLocalGoogleContactDirty("2026-07-18T12:00:01.000Z", "2026-07-18T12:00:00.000Z")).toBe(
      true,
    );
  });

  it("treats contacts updated before or at the last Google sync as clean", () => {
    expect(isLocalGoogleContactDirty("2026-07-18T12:00:00.000Z", "2026-07-18T12:00:00.000Z")).toBe(
      false,
    );
    expect(isLocalGoogleContactDirty("2026-07-18T11:59:59.000Z", "2026-07-18T12:00:00.000Z")).toBe(
      false,
    );
  });
});

describe("isGooglePhotoPushDirty", () => {
  it("is not dirty when there is no local avatar", () => {
    expect(
      isGooglePhotoPushDirty({ avatarUrl: null, photoEtag: null, photoPushAttempts: 0 }),
    ).toBe(false);
  });

  it("is not dirty when the pushed etag already matches the local avatar", () => {
    expect(
      isGooglePhotoPushDirty({
        avatarUrl: "storage://a.jpg",
        photoEtag: "storage://a.jpg",
        photoPushAttempts: 0,
      }),
    ).toBe(false);
  });

  it("is dirty on first-time push (no etag) and on avatar change", () => {
    expect(
      isGooglePhotoPushDirty({
        avatarUrl: "storage://a.jpg",
        photoEtag: null,
        photoPushAttempts: 0,
      }),
    ).toBe(true);
    expect(
      isGooglePhotoPushDirty({
        avatarUrl: "storage://b.jpg",
        photoEtag: "storage://a.jpg",
        photoPushAttempts: 2,
      }),
    ).toBe(true);
  });

  it("stops retrying after MAX_PHOTO_PUSH_ATTEMPTS", () => {
    expect(
      isGooglePhotoPushDirty({
        avatarUrl: "storage://a.jpg",
        photoEtag: null,
        photoPushAttempts: MAX_PHOTO_PUSH_ATTEMPTS,
      }),
    ).toBe(false);
    expect(
      isGooglePhotoPushDirty({
        avatarUrl: "storage://a.jpg",
        photoEtag: null,
        photoPushAttempts: MAX_PHOTO_PUSH_ATTEMPTS + 3,
      }),
    ).toBe(false);
  });
});
