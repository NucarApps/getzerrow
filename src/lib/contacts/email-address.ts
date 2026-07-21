/** Display-level email shape check shared by the emails editor's inline
 * validation and the contact detail view's autosave gate — a half-typed
 * address must pause autosave, not sync junk to CardDAV/Google. */
export function isValidEmailAddress(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}
