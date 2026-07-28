import { describe, expect, it } from "vitest";
import {
  isLocalGoogleContactDirty,
  isGooglePhotoPushDirty,
  isGooglePhotoLinkDirty,
  filterDirtyForPush,
  calculateMembershipDelta,
  isPushBackedOff,
  nextPushBackoffMs,
  MAX_PHOTO_PUSH_ATTEMPTS,
  PUSH_BACKOFF_BASE_MS,
  PUSH_BACKOFF_MAX_MS,
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

describe("calculateMembershipDelta", () => {
  it("adds missing Google memberships and removes stale memberships", () => {
    expect(
      calculateMembershipDelta({
        desiredResourceNames: ["people/a", "people/c"],
        currentResourceNames: ["people/a", "people/b"],
      }),
    ).toEqual({ toAdd: ["people/c"], toRemove: ["people/b"] });
  });

  it("treats duplicate local memberships as a single desired Google member", () => {
    expect(
      calculateMembershipDelta({
        desiredResourceNames: ["people/a", "people/a"],
        currentResourceNames: [],
      }),
    ).toEqual({ toAdd: ["people/a"], toRemove: [] });
  });
});

describe("isGooglePhotoPushDirty", () => {
  it("is not dirty when there is no local avatar", () => {
    expect(isGooglePhotoPushDirty({ avatarUrl: null, photoEtag: null, photoPushAttempts: 0 })).toBe(
      false,
    );
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

describe("isGooglePhotoLinkDirty", () => {
  it("visits linked contacts with no pushed photo etag so fallback logos can be resolved", () => {
    expect(isGooglePhotoLinkDirty({ photoEtag: null, photoPushAttempts: 0 })).toBe(true);
  });

  it("does not revisit links that already recorded a photo outcome", () => {
    expect(
      isGooglePhotoLinkDirty({
        photoEtag: "company-domain-logo:company:domain:sha",
        photoPushAttempts: 0,
      }),
    ).toBe(false);
    expect(isGooglePhotoLinkDirty({ photoEtag: "no-local-photo", photoPushAttempts: 0 })).toBe(
      false,
    );
  });

  it("stops retrying after MAX_PHOTO_PUSH_ATTEMPTS", () => {
    expect(
      isGooglePhotoLinkDirty({ photoEtag: null, photoPushAttempts: MAX_PHOTO_PUSH_ATTEMPTS }),
    ).toBe(false);
  });
});

describe("nextPushBackoffMs", () => {
  it("grows exponentially from the base delay", () => {
    expect(nextPushBackoffMs(1)).toBe(PUSH_BACKOFF_BASE_MS);
    expect(nextPushBackoffMs(2)).toBe(PUSH_BACKOFF_BASE_MS * 2);
    expect(nextPushBackoffMs(3)).toBe(PUSH_BACKOFF_BASE_MS * 4);
  });

  it("caps at PUSH_BACKOFF_MAX_MS so a stuck contact still retries daily-ish", () => {
    expect(nextPushBackoffMs(20)).toBe(PUSH_BACKOFF_MAX_MS);
    expect(nextPushBackoffMs(1000)).toBe(PUSH_BACKOFF_MAX_MS);
  });

  it("treats a missing/zero attempt count as the first failure", () => {
    expect(nextPushBackoffMs(0)).toBe(PUSH_BACKOFF_BASE_MS);
  });
});

describe("isPushBackedOff", () => {
  const now = Date.parse("2026-07-28T05:00:00.000Z");

  it("is not backed off when no backoff was ever recorded", () => {
    expect(isPushBackedOff({ push_backoff_until: null }, now)).toBe(false);
    expect(isPushBackedOff({ push_backoff_until: undefined }, now)).toBe(false);
  });

  it("suppresses the contact until the backoff expires", () => {
    expect(isPushBackedOff({ push_backoff_until: "2026-07-28T05:05:00.000Z" }, now)).toBe(true);
  });

  it("releases the contact once the backoff has passed", () => {
    expect(isPushBackedOff({ push_backoff_until: "2026-07-28T04:55:00.000Z" }, now)).toBe(false);
  });

  it("ignores an unparseable timestamp rather than wedging the contact forever", () => {
    expect(isPushBackedOff({ push_backoff_until: "not-a-date" }, now)).toBe(false);
  });
});

describe("filterDirtyForPush", () => {
  const syncedLink = (overrides: Partial<PushLinkState> = {}): PushLinkState => ({
    last_synced_at: "2026-07-19T12:00:00.000Z",
    photo_etag: null,
    photo_push_attempts: 0,
    push_backoff_until: null,
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

  it("drops dirty contacts that are still inside their push backoff window", () => {
    // Regression: a contact Google keeps rejecting (429 FBS quota) stayed
    // dirty forever and was re-attempted every run, burning the account's
    // daily write quota on a call that cannot succeed.
    const now = Date.parse("2026-07-28T05:00:00.000Z");
    const rows = [row("quota-stuck", "2026-07-28T04:00:00.000Z", "storage://new.jpg")];
    const links = new Map<string, PushLinkState>([
      ["quota-stuck", syncedLink({ push_backoff_until: "2026-07-28T05:30:00.000Z" })],
    ]);
    expect(filterDirtyForPush(rows, links, now)).toEqual([]);
    // ...and comes back once the window closes.
    expect(filterDirtyForPush(rows, links, Date.parse("2026-07-28T05:31:00.000Z"))).toEqual(rows);
  });

  it("never backs off an unlinked contact (nothing has failed yet)", () => {
    const rows = [row("brand-new", "2026-07-28T04:00:00.000Z")];
    expect(filterDirtyForPush(rows, new Map(), Date.parse("2026-07-28T05:00:00.000Z"))).toEqual(
      rows,
    );
  });
});
