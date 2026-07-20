/**
 * Client-safe phone helpers.
 *
 * `validatePhoneNumber` mirrors the server schema (phoneEntrySchema in
 * contacts-helpers.server.ts) so users get the same verdict inline before
 * we round-trip to the server.
 *
 * `normalizePhone` / `normalizePhones` produce a canonical key for
 * matching/deduplication (digits only, keeping a leading '+').
 */

const PHONE_NUMBER_RE = /^[+\d\s().,#*;:x/A-Za-z-]{3,60}$/;

/** Trim edges and collapse runs of any whitespace (incl. NBSP/tab/newline) to a single space. */
export function normalizePhoneDisplay(raw: string): string {
  return raw.replace(/[\s\u00A0]+/g, " ").trim();
}

/**
 * Canonical dedup/match key: keep a leading '+' if present, strip
 * everything except digits. Returns "" when nothing usable remains.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D+/g, "");
  if (!digits) return "";
  return hasPlus ? `+${digits}` : digits;
}

/** Normalize a list, dropping empties and duplicates while preserving order. */
export function normalizePhones(raw: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw) {
    const n = normalizePhone(p);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
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
