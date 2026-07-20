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

export type PushCandidate = {
  id: string;
  updated_at: string;
  avatar_url: string | null;
};

export type PushLinkState = {
  last_synced_at: string | null;
  photo_etag: string | null;
  photo_push_attempts: number | null;
};

/** Keep only contacts the push loop actually needs to visit: unlinked (new to
 *  Google), body-dirty, or photo-dirty. Selection MUST filter on dirtiness
 *  before applying any per-run cap — capping a blind updated_at slice starves
 *  recently-edited contacts on accounts larger than the cap, because every
 *  local edit (including photo saves) bumps updated_at and sorts the contact
 *  to the end of an ascending scan. */
export function filterDirtyForPush<T extends PushCandidate>(
  rows: T[],
  linkByContact: Map<string, PushLinkState>,
): T[] {
  return rows.filter((row) => {
    const link = linkByContact.get(row.id);
    if (!link) return true;
    return (
      isLocalGoogleContactDirty(row.updated_at, link.last_synced_at) ||
      isGooglePhotoPushDirty({
        avatarUrl: row.avatar_url ?? null,
        photoEtag: link.photo_etag ?? null,
        photoPushAttempts: link.photo_push_attempts ?? 0,
      })
    );
  });
}
