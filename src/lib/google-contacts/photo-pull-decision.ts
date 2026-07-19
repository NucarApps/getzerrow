import { isUserChosenPhotoSource } from "@/lib/contacts/photo-source";

export type GooglePhotoPullDecision = {
  action: "skip_unchanged" | "keep_user_photo" | "skip_logo" | "save";
  /** Record the remote URL as seen (photo_etag) so the pull doesn't retry
   * the same photo every cycle. */
  recordEtag: boolean;
};

/** Decide what to do with a changed Google contact photo. Evaluated in
 * cheap-first order: URL comparison and avatar_source need no byte fetch;
 * the known-logo check runs only when the caller had to download the bytes
 * (pass null when bytes were never fetched). */
export function decideGooglePhotoPull(input: {
  photoUrlChanged: boolean;
  avatarSource: string | null | undefined;
  incomingShaIsKnownLogo: boolean | null;
}): GooglePhotoPullDecision {
  if (!input.photoUrlChanged) return { action: "skip_unchanged", recordEtag: false };
  if (isUserChosenPhotoSource(input.avatarSource)) {
    return { action: "keep_user_photo", recordEtag: true };
  }
  if (input.incomingShaIsKnownLogo === true) return { action: "skip_logo", recordEtag: true };
  return { action: "save", recordEtag: true };
}
