// Redaction helpers for webhook diagnostics.
//
// The gmail-webhook route records which endpoint variant a push hit
// (path + query) into pubsub_events.subscription so ops can tell which
// Pub/Sub subscriptions still use the legacy ?token= URL. That token is a
// bearer secret — it must NEVER be persisted. These helpers replace every
// secret-bearing query value with a short fingerprint that is enough to
// distinguish tokens without revealing them.

const SECRET_QUERY_PARAMS = new Set(["token", "secret", "key", "apikey", "api_key"]);

/**
 * Fingerprint a secret for diagnostics: first two + last two characters and
 * the length, never the middle. Enough to tell two secrets apart, useless
 * for replay.
 */
export function fingerprintSecret(value: string | null | undefined): string {
  if (!value) return "(none)";
  if (value.length <= 4) return `(len ${value.length})`;
  return `${value.slice(0, 2)}…${value.slice(-2)} (len ${value.length})`;
}

/**
 * Redact secret-bearing query params in a URL search string.
 * `?token=abcd1234` → `?token=<redacted:ab…34 (len 8)>`.
 * Non-secret params pass through unchanged.
 */
export function redactSearch(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return "";
  const params = new URLSearchParams(raw);
  const out: string[] = [];
  for (const [name, value] of params.entries()) {
    if (SECRET_QUERY_PARAMS.has(name.toLowerCase())) {
      out.push(`${name}=<redacted:${fingerprintSecret(value)}>`);
    } else {
      out.push(`${name}=${value}`);
    }
  }
  return out.length > 0 ? `?${out.join("&")}` : "";
}

/** Loggable endpoint identity: pathname plus redacted query string. */
export function redactedEndpoint(url: URL): string {
  return `${url.pathname}${redactSearch(url.search)}`;
}
