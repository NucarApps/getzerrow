/**
 * Display-level email shape check, shared by the emails editor's inline
 * validation, the contact detail view's autosave gate, the meeting blocklist
 * card, and the calendar / autojoin attendee filters — a half-typed address
 * must pause autosave, not sync junk to CardDAV/Google.
 *
 * Deliberately loose: this is a "looks like an address" gate, not RFC 5322.
 * Client-safe (imports nothing server-only) so UI code can use it directly;
 * meetings-helpers.server re-exports EMAIL_RE for the server-side callers.
 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailAddress(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}
