/**
 * Normalize a company name for cross-domain matching.
 *
 * - Lowercases and trims.
 * - Strips punctuation (.,'"&/) and collapses whitespace.
 * - Strips trailing legal suffixes (inc, llc, ltd, co, corp, gmbh, s.a., sas,
 *   pty, plc, bv, ag, kg).
 * - Returns `null` when the result is empty or a single character so we don't
 *   merge on garbage inputs like "-" or "A".
 */
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "company",
  "gmbh",
  "sa",
  "sas",
  "pty",
  "plc",
  "bv",
  "ag",
  "kg",
  "srl",
  "spa",
  "oy",
  "ab",
]);

export function normalizeCompanyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.toLowerCase();
  // Strip punctuation to spaces
  s = s.replace(/[.,'"&/\\()\[\]:;!?]/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Strip trailing legal suffixes (repeatedly, e.g. "Honda Motor Co Ltd")
  let tokens = s.split(" ");
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  const out = tokens.join(" ").trim();
  if (out.length < 2) return null;
  return out;
}
