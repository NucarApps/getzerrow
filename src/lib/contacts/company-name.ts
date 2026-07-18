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

// Common corporate qualifiers stripped from either end so brand variants
// collapse to the same key. "Nissan Motor" / "Nissan North America" /
// "Hyundai USA" / "Ford Motor Company" all normalize to just the brand.
const QUALIFIERS = new Set([
  "motor",
  "motors",
  "group",
  "holdings",
  "holding",
  "international",
  "global",
  "worldwide",
  "usa",
  "us",
  "na",
  "americas",
  "america",
  "north",
  "south",
  "east",
  "west",
  "european",
  "europe",
  "asia",
  "pacific",
  "the",
]);

export function normalizeCompanyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.toLowerCase();
  // Strip punctuation to spaces
  s = s.replace(/[.,'"&/\\()\[\]:;!?-]/g, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  let tokens = s.split(" ");
  // Strip trailing legal suffixes repeatedly (e.g. "Honda Motor Co Ltd")
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
  }
  // Strip trailing qualifiers repeatedly ("Nissan North America" -> "Nissan")
  while (tokens.length > 1 && QUALIFIERS.has(tokens[tokens.length - 1])) {
    tokens = tokens.slice(0, -1);
    // A legal suffix may re-surface after removing a qualifier.
    while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
      tokens = tokens.slice(0, -1);
    }
  }
  // Strip leading qualifiers ("The Honda Company" -> "honda")
  while (tokens.length > 1 && QUALIFIERS.has(tokens[0])) {
    tokens = tokens.slice(1);
  }
  const out = tokens.join(" ").trim();
  if (out.length < 2) return null;
  return out;
}

