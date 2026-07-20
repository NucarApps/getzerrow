/**
 * Client-safe phone validation. Mirrors the server schema
 * (phoneEntrySchema in contacts-helpers.server.ts) so users get the same
 * verdict inline before we round-trip to the server.
 */

const PHONE_NUMBER_RE = /^[+\d\s().,#*;:x/A-Za-z-]{3,60}$/;

/** Trim edges and collapse runs of any whitespace (incl. NBSP/tab/newline) to a single space. */
export function normalizePhoneDisplay(raw: string): string {
  return raw.replace(/[\s\u00A0]+/g, " ").trim();
}

export type PhoneValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; normalized: string; reason: string };

export function validatePhoneNumber(raw: string): PhoneValidationResult {
  const normalized = normalizePhoneDisplay(raw);
  if (normalized.length < 3) {
    return { ok: false, normalized, reason: "Phone must be at least 3 characters" };
  }
  if (normalized.length > 60) {
    return { ok: false, normalized, reason: "Phone must be 60 characters or fewer" };
  }
  if (!PHONE_NUMBER_RE.test(normalized)) {
    // Point at the first character that failed to help the user find it.
    const allow = /[+\d\s().,#*;:x/A-Za-z-]/;
    const bad = Array.from(normalized).find((ch) => !allow.test(ch));
    return {
      ok: false,
      normalized,
      reason: bad
        ? `"${bad}" isn't a valid phone character`
        : "Phone contains invalid characters",
    };
  }
  return { ok: true, normalized };
}
