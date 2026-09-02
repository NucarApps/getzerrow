// Decision matrix for the CardDAV PUT photo echo guard.
//
// The guard exists because iOS re-PUTs whatever PHOTO bytes we last served
// when the user edits an unrelated field. For contacts without a personal
// avatar we serve a company-logo fallback, so a naive save would freeze that
// logo into `avatar_url`. The old guard over-matched: it skipped the save
// whenever the incoming bytes matched ANY known company logo for the user,
// which silently dropped photos the user deliberately picked on the iPhone
// (the "photo reverts after a minute" bug). The decision is now scoped to
// the one logo this specific contact could actually be echoing.

import { describe, it, expect } from "vitest";
import { decideIncomingPhoto } from "./photo-echo-decision";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_OTHER_LOGO = "d".repeat(64);

describe("decideIncomingPhoto", () => {
  it("skips as echo when incoming matches the fallback SHA served to this contact", () => {
    expect(
      decideIncomingPhoto({
        incomingSha: SHA_A,
        servedFallbackSha: SHA_A,
        currentAvatarSha: null,
        currentLogoShaForContact: null,
      }),
    ).toBe("skip_echo");
  });

  it("skips as noop when incoming matches the currently stored avatar", () => {
    expect(
      decideIncomingPhoto({
        incomingSha: SHA_B,
        servedFallbackSha: null,
        currentAvatarSha: SHA_B,
        currentLogoShaForContact: null,
      }),
    ).toBe("skip_noop");
  });

  it("skips as echo when incoming matches the logo a GET would inline today (sha-recording failed / logo rotated)", () => {
    expect(
      decideIncomingPhoto({
        incomingSha: SHA_C,
        servedFallbackSha: SHA_A, // stale recorded sha from before the rotation
        currentAvatarSha: null,
        currentLogoShaForContact: SHA_C,
      }),
    ).toBe("skip_echo");
  });

  it("SAVES when incoming matches none of this contact's known photos — even another company's logo", () => {
    // The fixed false positive: the user deliberately chose an image that
    // happens to be (or resemble) some other company's logo. Nothing about
    // THIS contact says we served it, so it must persist.
    expect(
      decideIncomingPhoto({
        incomingSha: SHA_OTHER_LOGO,
        servedFallbackSha: SHA_A,
        currentAvatarSha: null,
        currentLogoShaForContact: SHA_B,
      }),
    ).toBe("save");
  });

  it("saves a genuinely new photo when the contact has an existing different avatar", () => {
    expect(
      decideIncomingPhoto({
        incomingSha: SHA_A,
        servedFallbackSha: null,
        currentAvatarSha: SHA_B,
        currentLogoShaForContact: null,
      }),
    ).toBe("save");
  });

  it("saves when nothing is known about the contact's photos", () => {
    expect(
      decideIncomingPhoto({
        incomingSha: SHA_A,
        servedFallbackSha: null,
        currentAvatarSha: null,
        currentLogoShaForContact: null,
      }),
    ).toBe("save");
  });

  it("prefers skip_echo over skip_noop when the same bytes match both fallback and avatar", () => {
    // Degenerate case (an avatar that IS the recorded fallback). Either skip
    // is acceptable; pin echo-first so the precedence never flaps.
    expect(
      decideIncomingPhoto({
        incomingSha: SHA_A,
        servedFallbackSha: SHA_A,
        currentAvatarSha: SHA_A,
        currentLogoShaForContact: null,
      }),
    ).toBe("skip_echo");
  });
});

// The behavioural counterpart — that the PUT handler only ever skips on a
// SHA attributable to this contact, and saves anything else as a user
// upload — lives in handlers.put-delete.test.ts ("PUT PHOTO"), which drives
// the real handler instead of grepping its source.
