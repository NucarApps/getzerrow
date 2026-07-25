// Utilities for inferring a "company" from an email address.
// All client-safe; no server imports.

export const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "tutanota.com",
  "qq.com",
  "163.com",
  "126.com",
]);

const TWO_PART_TLDS = new Set([
  "co.uk",
  "ac.uk",
  "org.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "co.kr",
  "co.in",
  "co.za",
  "com.br",
  "com.mx",
  "com.ar",
  "com.sg",
  "com.hk",
  "com.tr",
]);

/**
 * THE canonical way to get a sender's domain from an address.
 *
 * Every domain-keyed routing decision must go through this — folder-rule
 * `domain` conditions, `domain_in` allowlists, and inbox overrides. Producers
 * and consumers previously used two disagreeing families (`extractDomain`, in
 * three variants, vs. an inline `split("@")[1]` at ten sites), so an override
 * written from a malformed sender could never match the domain the classifier
 * later computed for that same sender, and the rule silently never fired.
 *
 * Handles the addresses that actually reach us, including the ones
 * `parseMessage` used to store unnormalized:
 *   "jane@acme.com"                          -> "acme.com"
 *   "Jane Doe <jane@acme.com>"               -> "acme.com"
 *   'Jane "JD" Doe <jane@acme.com>'          -> "acme.com"
 *   "Jane <jane@acme.com> (Sales)"           -> "acme.com"
 *   "Jane <a@acme.com>, Bob <b@other.com>"   -> "acme.com"  (first address wins)
 *
 * Deliberately does NOT require a dot — that's a data-quality question, not a
 * parsing one. Callers that need it use `isRoutableDomain`. Returns null when
 * there is no parseable `@domain` part.
 */
export function emailDomain(addr: string | null | undefined): string | null {
  if (!addr) return null;
  // Prefer the first angle-bracketed address: a multi-address or
  // trailing-comment header must not drag the extra text into the domain.
  const angle = String(addr).match(/<([^>]*)>/);
  const raw = (angle ? angle[1] : String(addr)).trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at < 0) return null;
  const domain = raw
    .slice(at + 1)
    // Strip anything that can trail an address when the header was not
    // angle-bracketed: ">" from a partial parse, list separators, comments.
    .replace(/[>\s,;].*$/, "")
    .trim();
  return domain || null;
}

/**
 * Does `d` look like a real, routable domain (has a dot and a TLD)?
 *
 * Split out of `emailDomain` so parsing and validation stay separable. Use it
 * where a dotless value would corrupt data — a DB key, a company-name guess, a
 * grouping key — not as a security control.
 *
 * NOTE: intentionally NOT reusing `isValidDomainShape` from `logo-guards.ts`,
 * despite the identical regex. That module is an SSRF guard imported only by
 * server/route code; importing it here would drag `hostResolvesToPublicIp`
 * into the browser bundle, and folding a data-quality check into a security
 * guard is how guards get weakened later.
 */
export function isRoutableDomain(d: string | null | undefined): boolean {
  if (!d) return false;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d);
}

export function isPersonalDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return PERSONAL_DOMAINS.has(domain.toLowerCase());
}

/** "mail.acme.co.uk" -> "acme", "acme.com" -> "Acme". */
export function prettyCompanyName(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length === 0) return domain;
  let core = parts[parts.length - 2] ?? parts[0];
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join(".");
    if (TWO_PART_TLDS.has(lastTwo)) {
      core = parts[parts.length - 3] ?? core;
    }
  }
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/** Extract a clean domain from a website URL or raw domain string. */
export function domainFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  let s = String(website).trim().toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** Best logo domain for a contact: prefer their website, fall back to email domain. */
export function contactLogoDomain(
  website: string | null | undefined,
  email: string | null | undefined,
): string | null {
  const w = domainFromWebsite(website);
  if (w && !isPersonalDomain(w)) return w;
  const e = emailDomain(email);
  if (e && !isPersonalDomain(e)) return e;
  return null;
}

/** Ordered list of logo URLs to try for a domain. Only our same-origin proxy;
 *  if it 404s, the UI falls through to a first-letter monogram.
 *  When `provider` is a number, asks the proxy for that specific source only. */
export function logoCandidates(domain: string, size = 64, provider?: number | null): string[] {
  const d = encodeURIComponent(domain);
  const s = Math.max(size, 64);
  const base = `/api/public/logo?domain=${d}&size=${s}`;
  return [typeof provider === "number" ? `${base}&provider=${provider}` : base];
}

/** First-choice logo URL (kept for back-compat). */
export function logoUrl(domain: string, size = 64): string {
  return logoCandidates(domain, size)[0];
}

/** Resolve a domain through a user-defined alias map (alias -> primary). */
export function resolveCompanyDomain(
  domain: string | null | undefined,
  aliasMap: Map<string, string> | null | undefined,
): string | null {
  if (!domain) return null;
  const d = domain.toLowerCase();
  if (!aliasMap || aliasMap.size === 0) return d;
  return aliasMap.get(d) ?? d;
}
