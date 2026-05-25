// Per-user Google OAuth — token exchange, refresh, state signing.
// Used by /api/public/google-oauth-callback and gmail.server.ts.
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/** Sign { user_id, exp } with HMAC using the service role key as secret. Stateless OAuth state. */
export function signState(userId: string, ttlSeconds = 600): string {
  const secret = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const payload = b64url(JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyState(state: string): string {
  const secret = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const [payload, sig] = state.split(".");
  if (!payload || !sig) throw new Error("Malformed state");
  const expected = b64url(createHmac("sha256", secret).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("Invalid state signature");
  const parsed = JSON.parse(b64urlDecode(payload).toString("utf-8")) as { u: string; e: number };
  if (parsed.e < Math.floor(Date.now() / 1000)) throw new Error("State expired");
  return parsed.u;
}

export function buildAuthorizeUrl(redirectUri: string, state: string, loginHint?: string): string {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // force refresh_token
    include_granted_scopes: "true",
    state,
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    token_type: string;
    id_token?: string;
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const clientId = requireEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as { access_token: string; expires_in: number; scope: string; token_type: string };
}

export async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Userinfo failed ${res.status}`);
  const data = (await res.json()) as { email: string };
  return data.email;
}

// Per-account in-flight refresh promises. Coalesces concurrent jobs for the
// same account into a single OAuth refresh call. Scope is per-worker process,
// which is the right granularity — we want to prevent intra-process stampedes
// when N workers wake up around token expiry; different Workers each refreshing
// once is fine.
const inFlightRefresh = new Map<string, Promise<string>>();

type GetTokensRow = {
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string;
};
type OAuthRpc = {
  rpc:
    | ((
        fn: "get_gmail_oauth_tokens",
        args: { p_account_id: string },
      ) => Promise<{ data: GetTokensRow[] | null; error: { message: string } | null }>)
    | ((
        fn: "set_gmail_oauth_tokens",
        args: {
          p_account_id: string;
          p_access_token: string;
          p_refresh_token: string;
          p_token_expires_at: string;
        },
      ) => Promise<{ data: unknown; error: { message: string } | null }>);
};

// PostgREST returns this error code when a function isn't in its schema
// cache — i.e. the migration that creates the RPC hasn't been applied yet.
// We use that signal to fall back to the pre-encryption code path so the
// app doesn't break the moment new code ships ahead of new migrations.
function isMissingFunctionError(err: { message?: string } | null | undefined): boolean {
  if (!err?.message) return false;
  const m = err.message;
  return (
    m.includes("Could not find the function") ||
    m.includes("schema cache") ||
    m.includes("does not exist")
  );
}

/** Returns a fresh access token for the given gmail account, refreshing if
 * needed. Tokens are stored encrypted at rest via the
 * get_gmail_oauth_tokens / set_gmail_oauth_tokens RPCs (pgsodium AEAD).
 *
 * Falls back to direct-column SELECT/UPDATE when those RPCs aren't yet
 * deployed — preserves uptime during the deploy window between code
 * landing and migrations running.
 */
export async function getAccessToken(accountId: string): Promise<string> {
  const tokens = await fetchTokensWithFallback(accountId);
  if (!tokens) throw new Error("Gmail account not found");
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error("Gmail account is missing OAuth tokens — user needs to reauthorize");
  }

  const expMs = new Date(tokens.token_expires_at).getTime();
  if (expMs - Date.now() > 2 * 60 * 1000) return tokens.access_token;

  // If another caller is already refreshing this account, piggy-back.
  const existing = inFlightRefresh.get(accountId);
  if (existing) return existing;

  const refreshPromise = (async () => {
    const refreshed = await refreshAccessToken(tokens.refresh_token!);
    const newExp = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await persistRefreshedTokenWithFallback(accountId, refreshed.access_token, newExp);
    return refreshed.access_token;
  })();

  inFlightRefresh.set(accountId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefresh.delete(accountId);
  }
}

async function fetchTokensWithFallback(accountId: string): Promise<GetTokensRow | null> {
  const { data: rows, error } = await (supabaseAdmin as unknown as OAuthRpc).rpc(
    "get_gmail_oauth_tokens",
    { p_account_id: accountId },
  );
  if (!error) {
    return rows && rows.length > 0 ? rows[0] : null;
  }
  if (!isMissingFunctionError(error)) {
    throw new Error(`OAuth token fetch failed: ${error.message}`);
  }
  // RPC isn't deployed yet — fall back to the pre-encryption direct
  // SELECT. Same column names; same shape. Once the migration lands
  // the RPC succeeds and this branch stops running.
  console.warn("get_gmail_oauth_tokens RPC missing — falling back to direct SELECT");
  const { data, error: selErr } = await supabaseAdmin
    .from("gmail_accounts")
    .select("access_token, refresh_token, token_expires_at")
    .eq("id", accountId)
    .maybeSingle();
  if (selErr) throw new Error(`OAuth token fetch (fallback) failed: ${selErr.message}`);
  return data ?? null;
}

async function persistRefreshedTokenWithFallback(
  accountId: string,
  accessToken: string,
  expiresAt: string,
): Promise<void> {
  // Empty p_refresh_token preserves the existing encrypted refresh
  // token — Google only returns a new refresh_token during full
  // consent, not on plain refresh calls.
  const { error } = await (supabaseAdmin as unknown as OAuthRpc).rpc(
    "set_gmail_oauth_tokens",
    {
      p_account_id: accountId,
      p_access_token: accessToken,
      p_refresh_token: "",
      p_token_expires_at: expiresAt,
    },
  );
  if (!error) return;
  if (!isMissingFunctionError(error)) {
    throw new Error(`OAuth token update failed: ${error.message}`);
  }
  console.warn("set_gmail_oauth_tokens RPC missing — falling back to direct UPDATE");
  const { error: updErr } = await supabaseAdmin
    .from("gmail_accounts")
    .update({ access_token: accessToken, token_expires_at: expiresAt })
    .eq("id", accountId);
  if (updErr) throw new Error(`OAuth token update (fallback) failed: ${updErr.message}`);
}

export function getRedirectUri(origin: string): string {
  return `${origin}/api/public/google-oauth-callback`;
}
