// Where "this deployment" lives, for server fns that call back into their
// own public hooks with the cron secret attached.
//
// Deriving the URL from the incoming Host header is how the two self-hook
// callers used to work. On Cloudflare Workers the router only delivers
// requests for the configured hostnames, but a secret should still never
// be sent to a URL assembled from request input. Prefer an explicit
// APP_BASE_URL; fall back to the request host only when it is a plain
// hostname (no scheme, path, userinfo or whitespace).
import { getRequestHost } from "@tanstack/react-start/server";

const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

/** Origin of this deployment (`https://host`), or null when unknown. */
export function selfBaseUrl(): string | null {
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  let host: string | null;
  try {
    host = getRequestHost() ?? null;
  } catch {
    host = null;
  }
  if (!host || !HOST_RE.test(host)) return null;
  return `https://${host}`;
}

/**
 * Fire a POST at one of our own /api/public hooks with the cron secret.
 * Returns the URL used, or null (and does nothing) when the base URL or
 * secret is unavailable — callers treat that as "the periodic cron will
 * handle it".
 */
export async function kickHook(
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; keepalive?: boolean } = {},
): Promise<{ url: string; response: Promise<Response> } | null> {
  const base = selfBaseUrl();
  const cronSecret = process.env.CRON_SECRET;
  if (!base || !cronSecret) return null;
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  const response = fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cronSecret}`,
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify(opts.body ?? {}),
    ...(opts.keepalive ? { keepalive: true } : {}),
  });
  return { url, response };
}
