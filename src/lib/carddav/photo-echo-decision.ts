// Pure decision for the CardDAV PUT photo branch: is the incoming PHOTO an
// iOS echo of something we served, a redundant re-PUT, or a genuinely new
// user-chosen picture?
//
// Scope rule: only SHAs attributable to THIS contact may cause a skip — the
// fallback we recorded when serving it, its current avatar, or the logo a
// GET would inline for it right now. Matching some other company's logo is
// not evidence of an echo; treating it as one is how user photos got lost.

export type PhotoDecision = "skip_echo" | "skip_noop" | "save";

export function decideIncomingPhoto(input: {
  /** SHA-256 of the PHOTO bytes in the PUT. */
  incomingSha: string;
  /** contacts.company_logo_photo_sha — recorded when a GET served the logo fallback. */
  servedFallbackSha: string | null;
  /** SHA-256 of the currently stored avatar bytes, when one exists. */
  currentAvatarSha: string | null;
  /** SHA-256 of the logo a GET would inline for this contact today (only
   * relevant when it has no personal avatar). */
  currentLogoShaForContact: string | null;
}): PhotoDecision {
  const { incomingSha, servedFallbackSha, currentAvatarSha, currentLogoShaForContact } = input;
  if (servedFallbackSha !== null && incomingSha === servedFallbackSha) return "skip_echo";
  if (currentAvatarSha !== null && incomingSha === currentAvatarSha) return "skip_noop";
  if (currentLogoShaForContact !== null && incomingSha === currentLogoShaForContact) {
    return "skip_echo";
  }
  return "save";
}
