/**
 * Normalize a company name for deduplication — the MILD form: lowercase,
 * collapse whitespace, strip one trailing legal suffix. Must stay in sync with
 * the Postgres function `public.normalize_company_name`, so do not make it
 * more aggressive.
 *
 * For collapsing brand variants ("Nissan North America" -> "nissan") use
 * companyBrandKey in contacts/company-name.ts instead. The two used to share
 * the name `normalizeCompanyName`, which silently produced different dedup
 * keys depending on the import path.
 */
const SUFFIX_RE =
  /\s+(inc|inc\.|llc|l\.l\.c\.|ltd|ltd\.|limited|co|co\.|corp|corp\.|corporation|gmbh|s\.a\.|sa|ag|plc|pty|pty\.|pvt|pvt\.)\s*$/i;

export function normalizeCompanyNameDbSynced(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const stripped = trimmed.replace(SUFFIX_RE, "").replace(/\s+/g, " ").trim();
  return stripped || null;
}
