// Per-user Google OAuth — token exchange, refresh, state signing.
// Used by /api/public/google-oauth-callback and gmail.server.ts.
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  CALENDAR_SCOPE,
  CONTACTS_SCOPE,
  "openid",
];

/** True when Google's granted-scope string includes Calendar read access. */
export function scopeGrantsCalendar(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/\s+/).includes(CALENDAR_SCOPE);
}

/** True when Google's granted-scope string includes People API / Contacts access. */
export function scopeGrantsContacts(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/\s+/).includes(CONTACTS_SCOPE);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/** Sign { user_id, exp } with HMAC using the service role key as secret. Stateless OAuth state. */
export function signState(userId: string, ttlSeconds = 600): string {
  const secret = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const payload = b64url(
    JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + ttlSeconds }),
  );
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
    prompt: "select_account consent", // force account picker + refresh_token
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
  return JSON.parse(text) as {
    access_token: string;
    expires_in: number;
    scope: string;
    token_type: string;
  };
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
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: GetTokensRow[] | null; error: { message: string } | null }>;
};

function requireEncKey(): string {
  const k = process.env.EMAIL_ENC_KEY;
  if (!k) throw new Error("EMAIL_ENC_KEY is not configured");
  return k;
}

/**
 * Mark the account as needing a reconnect so callers stop retrying a broken
 * OAuth pair and the UI can surface a clear "Reconnect Gmail" banner.
 * Distinguished from transient failures (5xx, network) and app-wide credential
 * misconfig — only a dead user grant (`invalid_grant` / `invalid_token` /
 * missing token) should flip this flag.
 */
async function markNeedsReconnect(accountId: string, reason: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("gmail_accounts")
      .update({ needs_reconnect: true, last_oauth_error: reason.slice(0, 500) })
      .eq("id", accountId);
  } catch (e) {
    console.error("markNeedsReconnect failed", {
      account_id: accountId,
      err: (e as Error)?.message,
    });
  }
}

/**
 * True when Google rejected the refresh because the *user's grant* is dead
 * (revoked / expired refresh token). This is per-account and permanent —
 * only the user reconnecting can fix it.
 *
 * NOTE: `invalid_client` / `unauthorized_client` are deliberately excluded.
 * Those mean the app's own OAuth client_id/secret is wrong or missing — a
 * server-side config problem that affects every account under this client.
 * Flagging the user's account needs_reconnect for that would (a) permanently
 * disable a healthy account and (b) be unfixable via reconnect while the
 * secret is wrong. Those are surfaced as app-credential errors instead.
 */
function isPermanentOauthFailure(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /invalid_grant|invalid_token/i.test(msg);
}

/**
 * True when Google rejected the request because the app's OAuth client
 * credentials are invalid/missing (`invalid_client`, `unauthorized_client`).
 * This is a deployment-config issue (stale/rotated GOOGLE_OAUTH_CLIENT_SECRET),
 * not a per-user problem — do NOT flip needs_reconnect; retry once fixed.
 */
function isAppCredentialFailure(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /invalid_client|unauthorized_client/i.test(msg);
}

export class NeedsReconnectError extends Error {
  accountId: string;
  constructor(accountId: string, reason: string) {
    super(`Account ${accountId} needs reconnect: ${reason}`);
    this.name = "NeedsReconnectError";
    this.accountId = accountId;
  }
}

/**
 * Thrown when Google rejects the app's own OAuth client credentials
 * (`invalid_client` / `unauthorized_client`). This is a server-side config
 * problem (missing/stale/rotated GOOGLE_OAUTH_CLIENT_SECRET), not a per-user
 * grant failure — the account is NOT flagged needs_reconnect, so it recovers
 * automatically once the deployment secret is corrected.
 */
export class AppCredentialError extends Error {
  accountId: string;
  constructor(accountId: string, reason: string) {
    super(`Google rejected app OAuth credentials: ${reason}`);
    this.name = "AppCredentialError";
    this.accountId = accountId;
  }
}

/** Returns a fresh access token for the given gmail account, refreshing if
 * needed. Tokens are stored encrypted at rest via pgcrypto pgp_sym_*; the
 * key is held server-side (EMAIL_ENC_KEY) and passed per-call. Existing
 * unmigrated rows still resolve via COALESCE on plaintext columns.
 *
 * Throws `NeedsReconnectError` (and flips `gmail_accounts.needs_reconnect`)
 * when the OAuth grant is permanently dead. Callers that loop over multiple
 * accounts should catch this and skip the account rather than burning the
 * whole batch.
 */
export async function getAccessToken(accountId: string): Promise<string> {
  const key = requireEncKey();

  // Short-circuit: if a previous call already flagged this account, don't
  // burn another Gmail/refresh roundtrip until the user reconnects.
  const { data: status } = await supabaseAdmin
    .from("gmail_accounts")
    .select("needs_reconnect, last_oauth_error")
    .eq("id", accountId)
    .maybeSingle();
  if (status?.needs_reconnect) {
    throw new NeedsReconnectError(accountId, status.last_oauth_error ?? "needs_reconnect=true");
  }

  const { data: rows, error } = await (supabaseAdmin as unknown as OAuthRpc).rpc(
    "get_gmail_oauth_tokens",
    { p_account_id: accountId, p_key: key },
  );
  if (error) throw new Error(`OAuth token fetch failed: ${error.message}`);
  if (!rows || rows.length === 0) throw new Error("Gmail account not found");
  const acc = rows[0];
  if (!acc.access_token || !acc.refresh_token) {
    const reason = "Refresh token missing — reconnect required to keep mail flowing.";
    await markNeedsReconnect(accountId, reason);
    throw new NeedsReconnectError(accountId, reason);
  }

  const expMs = new Date(acc.token_expires_at).getTime();
  if (expMs - Date.now() > 2 * 60 * 1000) return acc.access_token;

  const existing = inFlightRefresh.get(accountId);
  if (existing) return existing;

  const refreshPromise = (async () => {
    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      refreshed = await refreshAccessToken(acc.refresh_token!);
    } catch (e) {
      if (isAppCredentialFailure(e)) {
        // App-wide credential/config problem — do NOT flag the account.
        // Log loudly so the deployment secret can be fixed; the account
        // recovers on its own once GOOGLE_OAUTH_CLIENT_SECRET is corrected.
        console.error("google-oauth.app_credential_invalid", {
          account_id: accountId,
          err: (e as Error)?.message?.slice(0, 300),
        });
        throw new AppCredentialError(accountId, (e as Error).message.slice(0, 300));
      }
      if (isPermanentOauthFailure(e)) {
        const reason = `Google rejected the refresh token: ${(e as Error).message.slice(0, 300)}`;
        await markNeedsReconnect(accountId, reason);
        throw new NeedsReconnectError(accountId, reason);
      }
      throw e;
    }
    const newExp = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    // Empty p_refresh_token preserves the existing encrypted refresh token.
    const { error: setErr } = await (supabaseAdmin as unknown as OAuthRpc).rpc(
      "set_gmail_oauth_tokens",
      {
        p_account_id: accountId,
        p_access_token: refreshed.access_token,
        p_refresh_token: "",
        p_token_expires_at: newExp,
        p_key: key,
      },
    );
    if (setErr) throw new Error(`OAuth token update failed: ${setErr.message}`);
    return refreshed.access_token;
  })();

  inFlightRefresh.set(accountId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    inFlightRefresh.delete(accountId);
  }
}

/** Clear the needs_reconnect flag — called after a successful re-OAuth. */
export async function clearNeedsReconnect(accountId: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("gmail_accounts")
      .update({ needs_reconnect: false, last_oauth_error: null, consecutive_silent_ticks: 0 })
      .eq("id", accountId);
  } catch (e) {
    console.error("clearNeedsReconnect failed", {
      account_id: accountId,
      err: (e as Error)?.message,
    });
  }
}

export function getRedirectUri(origin: string): string {
  return `${origin}/api/public/google-oauth-callback`;
}

/**
 * Best-effort: revoke the Google OAuth grant for an account so that the
 * refresh token is invalidated at Google. Caller should swallow errors —
 * this runs before we delete our encrypted copy and we still want the local
 * delete to succeed even if Google is unreachable.
 */
export async function revokeGoogleOAuthForAccount(accountId: string): Promise<void> {
  const key = requireEncKey();
  const { data: rows, error } = await (supabaseAdmin as unknown as OAuthRpc).rpc(
    "get_gmail_oauth_tokens",
    { p_account_id: accountId, p_key: key },
  );
  if (error || !rows || rows.length === 0) return;
  const acc = rows[0];
  const token = acc.refresh_token || acc.access_token;
  if (!token) return;
  const res = await fetch(
    `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    },
  );
  // Google returns 200 on success; 400 with "invalid_token" if already
  // revoked or expired. Either is acceptable for our purposes.
  if (!res.ok && res.status !== 400) {
    throw new Error(`Google revoke returned ${res.status}`);
  }
}
