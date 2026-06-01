import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m as { default?: ServerEntry }).default ?? (m as unknown as ServerEntry),
    );
  }
  return serverEntryPromise;
}

function brandedErrorResponse(): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function supabaseOrigins(): string {
  const url = process.env.SUPABASE_URL ?? "";
  try {
    const { origin, host } = new URL(url);
    // Realtime uses a wss:// connection to the same host.
    return `${origin} wss://${host}`;
  } catch {
    return "";
  }
}

// A hardened header set expected by OAuth restricted-scope (CASA) reviews.
// CSP is tuned for this app: SSR injects inline hydration scripts, fonts come
// from Google Fonts, logos/avatars are fetched from arbitrary company domains,
// and the browser talks to Supabase (REST + realtime wss) and the Lovable
// OAuth broker.
function securityHeaders(): Record<string, string> {
  const supabase = supabaseOrigins();
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    `connect-src 'self' ${supabase} https://oauth.lovable.app`.replace(/\s+/g, " ").trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
  ].join("; ");

  return {
    "content-security-policy": csp,
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
  };
}

// Merge the security headers onto an existing response, preserving its body,
// status, and existing headers (content-type, redirect Location, etc.).
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isCatastrophicSsrErrorBody(body: string, responseStatus: number): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return false;
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return false;
  }

  const fields = payload as Record<string, unknown>;
  const expectedKeys = new Set(["message", "status", "unhandled"]);
  if (!Object.keys(fields).every((key) => expectedKeys.has(key))) {
    return false;
  }

  return (
    fields.unhandled === true &&
    fields.message === "HTTPError" &&
    (fields.status === undefined || fields.status === responseStatus)
  );
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isCatastrophicSsrErrorBody(body, response.status)) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return brandedErrorResponse();
}

// On Cloudflare Workers, environment bindings (vars + secrets) are injected
// per-request as the `env` argument to `fetch`, NOT automatically onto
// `process.env`. The generated Supabase integration reads its config from
// `process.env.*` during SSR (with `import.meta.env.VITE_*` as the build-time
// path). When the published build can't inline the VITE_ values, SSR falls
// back to `process.env`, which is empty unless we bridge the bindings here.
// This copies any string-valued bindings into `process.env` once, on the
// first request, without logging or hardcoding secret values.
function bridgeEnvToProcess(env: unknown): void {
  if (!env || typeof env !== "object") return;
  const target = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
  if (!target) return;
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === "string" && target[key] === undefined) {
      target[key] = value;
    }
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      bridgeEnvToProcess(env);
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return withSecurityHeaders(await normalizeCatastrophicSsrResponse(response));
    } catch (error) {
      console.error(error);
      return withSecurityHeaders(brandedErrorResponse());
    }
  },
};
