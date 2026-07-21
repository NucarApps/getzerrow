// SSRF guard for user-supplied webhook URLs (rules upgrade, task 5).
//
// A webhook URL is attacker-influencable configuration that the server
// will fetch — the classic SSRF vector. This guard is intentionally
// strict and static (no DNS resolution, which isn't available pre-fetch
// on Workers): https only, no credentials in the URL, bounded length,
// and IP-literal hosts must not be loopback / private / link-local /
// CGNAT / metadata ranges. Hostnames that *resolve* to private IPs are
// out of scope here — the fetch runs from Cloudflare's edge, outside the
// private network perimeter.
//
// Pure string logic — no I/O — so tests cover it directly.

export const MAX_WEBHOOK_URL_LEN = 2048;

export type UrlGuardResult = { ok: true; url: URL } | { ok: false; reason: string };

function ipv4Octets(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function isBlockedIpv4(o: number[]): string | null {
  if (o[0] === 127) return "loopback address";
  if (o[0] === 10) return "private address (RFC1918)";
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return "private address (RFC1918)";
  if (o[0] === 192 && o[1] === 168) return "private address (RFC1918)";
  if (o[0] === 169 && o[1] === 254) return "link-local address";
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return "carrier-grade NAT address";
  if (o[0] === 0) return "unspecified address";
  return null;
}

function isBlockedIpv6(host: string): string | null {
  // URL() normalizes IPv6 hosts to bracketed lowercase form.
  const ip = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return "loopback address";
  if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return "unspecified address";
  if (/^fe[89ab]/.test(ip)) return "link-local address";
  if (/^f[cd]/.test(ip)) return "unique-local address";
  if (ip.startsWith("::ffff:")) {
    const v4 = ipv4Octets(ip.slice("::ffff:".length));
    if (v4) return isBlockedIpv4(v4);
    return "IPv4-mapped address";
  }
  return null;
}

/** Validate a user-supplied webhook URL. Never throws. */
export function validateWebhookUrl(raw: string): UrlGuardResult {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, reason: "webhook URL is empty" };
  if (input.length > MAX_WEBHOOK_URL_LEN) {
    return { ok: false, reason: `webhook URL longer than ${MAX_WEBHOOK_URL_LEN} characters` };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "webhook URL is not a valid URL" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "webhook URL must use https" };
  if (url.username || url.password) {
    return { ok: false, reason: "webhook URL must not contain credentials" };
  }

  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "webhook URL has no host" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "webhook host resolves to localhost" };
  }

  if (host.startsWith("[") || host.includes(":")) {
    const blocked = isBlockedIpv6(host);
    if (blocked) return { ok: false, reason: `webhook host is a ${blocked}` };
    return { ok: true, url };
  }

  const v4 = ipv4Octets(host);
  if (v4) {
    const blocked = isBlockedIpv4(v4);
    if (blocked) return { ok: false, reason: `webhook host is a ${blocked}` };
  }

  return { ok: true, url };
}
