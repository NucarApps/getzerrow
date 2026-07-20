import { describe, expect, it } from "vitest";
import {
  isLocalGoogleContactDirty,
  isGooglePhotoPushDirty,
  filterDirtyForPush,
  MAX_PHOTO_PUSH_ATTEMPTS,
  type PushLinkState,
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

describe("filterDirtyForPush", () => {
  const syncedLink = (overrides: Partial<PushLinkState> = {}): PushLinkState => ({
    last_synced_at: "2026-07-19T12:00:00.000Z",
    photo_etag: null,
    photo_push_attempts: 0,
    ...overrides,
  });
  const row = (id: string, updatedAt: string, avatarUrl: string | null = null) => ({
    id,
    updated_at: updatedAt,
    avatar_url: avatarUrl,
  });

  it("keeps unlinked contacts (they must be created on Google)", () => {
    const rows = [row("a", "2026-07-01T00:00:00.000Z")];
    expect(filterDirtyForPush(rows, new Map())).toEqual(rows);
  });

  it("drops clean linked contacts and keeps body-dirty ones regardless of position", () => {
    // Regression: the old push selected a blind oldest-200 slice, so a
    // recently-edited contact (newest updated_at) was never examined on
    // accounts with more than 200 rows. Selection must be dirtiness-first.
    const rows = [
      row("stale-clean", "2026-01-01T00:00:00.000Z"),
      row("recently-edited", "2026-07-19T18:00:00.000Z"),
    ];
    const links = new Map<string, PushLinkState>([
      ["stale-clean", syncedLink()],
      ["recently-edited", syncedLink()], // edited after last_synced_at → dirty
    ]);
    expect(filterDirtyForPush(rows, links).map((r) => r.id)).toEqual(["recently-edited"]);
  });

  it("keeps photo-only dirty contacts even when the body is in sync", () => {
    const rows = [row("photo-added", "2026-07-19T11:00:00.000Z", "storage://new.jpg")];
    const links = new Map<string, PushLinkState>([["photo-added", syncedLink()]]);
    expect(filterDirtyForPush(rows, links).map((r) => r.id)).toEqual(["photo-added"]);
  });

  it("drops photo-dirty contacts that exhausted the retry budget", () => {
    const rows = [row("gave-up", "2026-07-19T11:00:00.000Z", "storage://new.jpg")];
    const links = new Map<string, PushLinkState>([
      ["gave-up", syncedLink({ photo_push_attempts: MAX_PHOTO_PUSH_ATTEMPTS })],
    ]);
    expect(filterDirtyForPush(rows, links)).toEqual([]);
  });
});
