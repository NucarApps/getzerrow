export function isLocalGoogleContactDirty(
  localUpdatedAt: string | null | undefined,
  lastSyncedAt: string | null | undefined,
): boolean {
  if (!localUpdatedAt) return false;
  if (!lastSyncedAt) return true;
  return new Date(localUpdatedAt).getTime() > new Date(lastSyncedAt).getTime();
}

/** Maximum number of consecutive Google photo upload failures before we
 *  stop retrying for a given contact. */
export const MAX_PHOTO_PUSH_ATTEMPTS = 5;

/** True when a Google-linked contact's avatar bytes need to be pushed:
 *  the local avatar_url differs from the URL last pushed (`photo_etag`)
 *  and we haven't already exhausted the retry budget. */
export function isGooglePhotoPushDirty(input: {
  avatarUrl: string | null | undefined;
  photoEtag: string | null | undefined;
  photoPushAttempts: number | null | undefined;
}): boolean {
  const avatar = input.avatarUrl ?? null;
  if (!avatar) return false;
  const etag = input.photoEtag ?? null;
  if (avatar === etag) return false;
  const attempts = input.photoPushAttempts ?? 0;
  return attempts < MAX_PHOTO_PUSH_ATTEMPTS;
}
