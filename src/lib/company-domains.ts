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
  const e = extractDomain(email);
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

