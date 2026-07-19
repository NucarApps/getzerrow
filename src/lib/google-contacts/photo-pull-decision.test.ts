// Google Contacts pull: when the remote photo URL changes, decide whether to
// overwrite the local avatar. A photo the user explicitly set (iPhone/web)
// must never be clobbered by a Google refetch — that was the second half of
// the "iPhone photo reverts" bug. The remote URL is still recorded as seen
// in every skip case so the pull doesn't refetch the same photo forever.

import { describe, it, expect } from "vitest";
import { decideGooglePhotoPull } from "./photo-pull-decision";

describe("decideGooglePhotoPull", () => {
  it("skips entirely when the remote URL has not changed", () => {
    expect(
      decideGooglePhotoPull({
        photoUrlChanged: false,
        avatarSource: "google",
        incomingShaIsKnownLogo: null,
      }),
    ).toEqual({ action: "skip_unchanged", recordEtag: false });
  });

  it("keeps a user-chosen photo without even fetching bytes, but records the etag", () => {
    for (const source of ["user_upload", "carddav"] as const) {
      expect(
        decideGooglePhotoPull({
          photoUrlChanged: true,
          avatarSource: source,
          incomingShaIsKnownLogo: null,
        }),
      ).toEqual({ action: "keep_user_photo", recordEtag: true });
    }
  });

  it("skips known company-logo bytes but records the etag", () => {
    expect(
      decideGooglePhotoPull({
        photoUrlChanged: true,
        avatarSource: "google",
        incomingShaIsKnownLogo: true,
      }),
    ).toEqual({ action: "skip_logo", recordEtag: true });
  });

  it("saves a genuinely new Google photo over machine-sourced avatars", () => {
    for (const source of ["google", "company_logo", "unknown", null] as const) {
      expect(
        decideGooglePhotoPull({
          photoUrlChanged: true,
          avatarSource: source,
          incomingShaIsKnownLogo: false,
        }),
      ).toEqual({ action: "save", recordEtag: true });
    }
  });
});
