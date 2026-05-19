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

/** Returns a fresh access token for the given gmail account, refreshing if needed. */
export async function getAccessToken(accountId: string): Promise<string> {
  const { data: acc, error } = await supabaseAdmin
    .from("gmail_accounts")
    .select("id, access_token, refresh_token, token_expires_at")
    .eq("id", accountId)
    .single();
  if (error || !acc) throw new Error("Gmail account not found");

  const expMs = new Date(acc.token_expires_at).getTime();
  if (expMs - Date.now() > 2 * 60 * 1000) return acc.access_token;

  const refreshed = await refreshAccessToken(acc.refresh_token);
  const newExp = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await supabaseAdmin
    .from("gmail_accounts")
    .update({ access_token: refreshed.access_token, token_expires_at: newExp })
    .eq("id", accountId);
  return refreshed.access_token;
}

export function getRedirectUri(origin: string): string {
  return `${origin}/api/public/google-oauth-callback`;
}
