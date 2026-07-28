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

/** Body-push retry pacing. Unlike the photo lane there is no hard give-up:
 *  the dominant failure (People API 429 "FBS quota limit exceeded") is a
 *  per-account daily write quota that DOES clear, so a contact must eventually
 *  come back. What must not happen is re-attempting it every few minutes —
 *  each doomed write burns quota the rest of the account needs. */
export const PUSH_BACKOFF_BASE_MS = 5 * 60_000; // 5 min after the first failure
export const PUSH_BACKOFF_MAX_MS = 6 * 60 * 60_000; // ...growing to 6 h

/** Backoff window earned by the `attempts`-th consecutive failure (1-based).
 *  Doubles each time, capped at PUSH_BACKOFF_MAX_MS. */
export function nextPushBackoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  // Cap the exponent before shifting so a large attempt count can't overflow.
  const doublings = Math.min(n - 1, 32);
  return Math.min(PUSH_BACKOFF_BASE_MS * 2 ** doublings, PUSH_BACKOFF_MAX_MS);
}

/** True when a link's last failure is still cooling off. An unparseable or
 *  absent timestamp reads as "not backed off" — a bad value must never wedge
 *  a contact out of sync permanently. */
export function isPushBackedOff(
  link: { push_backoff_until?: string | null },
  now: number = Date.now(),
): boolean {
  const until = link.push_backoff_until;
  if (!until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now;
}

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

/** True when a linked Google contact should be visited by the photo lane.
 *  This intentionally does not require `avatar_url`: contacts can inherit an
 *  uploaded company logo or selected domain logo even when they have no own
 *  stored photo. The worker resolves the effective bytes later. */
export function isGooglePhotoLinkDirty(input: {
  photoEtag: string | null | undefined;
  photoPushAttempts: number | null | undefined;
}): boolean {
  if (input.photoEtag !== null && input.photoEtag !== undefined) return false;
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
  push_backoff_until?: string | null;
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
  now: number = Date.now(),
): T[] {
  return rows.filter((row) => {
    const link = linkByContact.get(row.id);
    if (!link) return true;
    // A cooling-off link is skipped in BOTH lanes: the two share one visit and
    // one People API budget, so letting the photo lane through would keep
    // spending quota on an account Google is already refusing.
    if (isPushBackedOff(link, now)) return false;
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

export function calculateMembershipDelta(input: {
  desiredResourceNames: Iterable<string>;
  currentResourceNames: Iterable<string>;
}): { toAdd: string[]; toRemove: string[] } {
  const desired = new Set(input.desiredResourceNames);
  const current = new Set(input.currentResourceNames);
  return {
    toAdd: [...desired].filter((resourceName) => !current.has(resourceName)),
    toRemove: [...current].filter((resourceName) => !desired.has(resourceName)),
  };
}
