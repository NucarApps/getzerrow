export function isLocalGoogleContactDirty(
  localUpdatedAt: string | null | undefined,
  lastSyncedAt: string | null | undefined,
): boolean {
  if (!localUpdatedAt) return false;
  if (!lastSyncedAt) return true;
  return new Date(localUpdatedAt).getTime() > new Date(lastSyncedAt).getTime();
}
