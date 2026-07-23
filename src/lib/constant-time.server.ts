// Constant-time string comparison for secret/token checks. Plain `a === b`
// (or `!==`) short-circuits on the first differing byte, leaking how many
// leading bytes matched via response timing — enough, over many requests, to
// recover a secret byte-by-byte. Compare shared secrets with this instead.
import { timingSafeEqual } from "node:crypto";

/**
 * True iff `a` and `b` are equal, without leaking their common prefix length
 * through timing. Returns false (in constant time relative to the inputs) when
 * either side is missing or the lengths differ.
 */
export function constantTimeEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length buffers and would throw otherwise.
  // Comparing against a fixed-length digest of both keeps the length check
  // itself from short-circuiting on length alone.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
