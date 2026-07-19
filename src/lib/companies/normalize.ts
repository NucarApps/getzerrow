/**
 * Normalize a company name for deduplication. Must stay in sync with the
 * Postgres function `public.normalize_company_name`.
 */
const SUFFIX_RE =
  /\s+(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|limited|co|co\.|corp|corp\.|corporation|gmbh|s\.a\.|sa|ag|plc|pty|pty\.|pvt|pvt\.)\s*$/i;

export function normalizeCompanyName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const stripped = trimmed.replace(SUFFIX_RE, "").replace(/\s+/g, " ").trim();
  return stripped || null;
}
