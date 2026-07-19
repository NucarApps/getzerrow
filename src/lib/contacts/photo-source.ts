import type { ContactPhotoSource } from "./photos.server";

/** Whether `contacts.avatar_source` records a photo a human explicitly chose.
 * "user_upload" is the web/app uploader (and what CardDAV PUTs persist);
 * "carddav" is the legacy label for older iPhone Contacts saves. Reconcilers
 * (Google pull, logo cleanup, getContact self-heal) must never replace these. */
export function isUserChosenPhotoSource(
  source: ContactPhotoSource | string | null | undefined,
): boolean {
  return source === "user_upload" || source === "carddav";
}
