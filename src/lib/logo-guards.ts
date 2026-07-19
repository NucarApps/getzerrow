// Pure guard logic for the /api/public/logo proxy.
// Extracted so we can regression-test SSRF defenses (DNS rebinding, private
// IP resolutions, embedded IP tricks) without spinning up the HTTP handler.

const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

const BLOCKED_HOST_RE =
  /(^|\.)(localhost|local|internal|intranet|corp|home|lan|test|example|invalid|onion)$/i;
const BLOCKED_SUFFIX_RE = /\.(nip\.io|sslip\.io|xip\.io|localtest\.me)$/i;
const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;
const EMBEDDED_IP_RE = /(?:^|\.)(?:10|127|0|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./;

export const TRUSTED_HOSTS = new Set([
  "img.logo.dev",
  "logo.clearbit.com",
  "icons.duckduckgo.com",
  "www.google.com",
]);

export function isValidDomainShape(domain: string): boolean {
  return DOMAIN_RE.test(domain);
}

export function isBlockedDomain(domain: string): boolean {
  if (IP_LITERAL_RE.test(domain)) return true;
  if (BLOCKED_HOST_RE.test(domain)) return true;
  if (BLOCKED_SUFFIX_RE.test(domain)) return true;
  if (EMBEDDED_IP_RE.test(`.${domain}`)) return true;
  return false;
}

export function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export function ipv6IsPrivate(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fc") || s.startsWith("fd")) return true;
  if (s.startsWith("fe80")) return true;
  if (s.startsWith("ff")) return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  return false;
}

export type DohAnswer = { name: string; type: number; data: string };
export type DohResolver = (host: string, type: "A" | "AAAA") => Promise<string[]>;

/** Real DoH resolver used in production. Kept here so tests can swap it. */
export const cloudflareDohResolver: DohResolver = async (host, type) => {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { Answer?: DohAnswer[] };
    const wanted = type === "A" ? 1 : 28;
    return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
  } catch {
    return [];
  }
};

/** Returns true iff every resolved IP for `host` is public. Trusted provider
 * hosts short-circuit without a lookup. Empty answers fail closed. */
export async function hostResolvesToPublicIp(
  host: string,
  resolver: DohResolver = cloudflareDohResolver,
): Promise<boolean> {
  if (TRUSTED_HOSTS.has(host.toLowerCase())) return true;
  const [a, aaaa] = await Promise.all([resolver(host, "A"), resolver(host, "AAAA")]);
  const all = [...a, ...aaaa];
  if (all.length === 0) return false;
  for (const ip of all) {
    if (ip.includes(":") ? ipv6IsPrivate(ip) : ipv4IsPrivate(ip)) return false;
  }
  return true;
}
