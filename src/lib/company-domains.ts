// Utilities for inferring a "company" from an email address.
// All client-safe; no server imports.

export const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com",
  "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me",
  "aol.com", "gmx.com", "gmx.de", "mail.com",
  "zoho.com", "fastmail.com", "tutanota.com",
  "qq.com", "163.com", "126.com",
]);

const TWO_PART_TLDS = new Set([
  "co.uk", "ac.uk", "org.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.nz", "co.jp", "co.kr", "co.in", "co.za",
  "com.br", "com.mx", "com.ar", "com.sg", "com.hk", "com.tr",
]);

export function extractDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  if (!d || !d.includes(".")) return null;
  return d;
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

/** Ordered list of public logo/favicon providers to try for a domain. */
export function logoCandidates(domain: string, size = 64): string[] {
  const d = encodeURIComponent(domain);
  const s = Math.max(size, 64);
  return [
    `https://www.google.com/s2/favicons?domain=${d}&sz=${s}`,
    `https://icons.duckduckgo.com/ip3/${d}.ico`,
    `https://logo.clearbit.com/${d}`,
  ];
}

/** First-choice logo URL (kept for back-compat). */
export function logoUrl(domain: string, size = 64): string {
  return logoCandidates(domain, size)[0];
}
