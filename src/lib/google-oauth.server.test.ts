import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake } from "./__fixtures__/supabase-fake";

// Shared fake for revokeGoogleOAuthForAccount (the only supabase consumer in
// this file). Methods are deferred into bodies so the vi.mock factory never
// touches `fake` before this module finishes initializing.
const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

import {
  CALENDAR_SCOPE,
  CONTACTS_SCOPE,
  GMAIL_SCOPES,
  scopeGrantsCalendar,
  scopeGrantsContacts,
  signState,
  verifyState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  revokeGoogleOAuthForAccount,
} from "./google-oauth.server";

const SERVICE_KEY = "test-service-role-key";
const ENV_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "EMAIL_ENC_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.EMAIL_ENC_KEY = "test-enc-key";
  fake.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

describe("scopeGrantsCalendar / scopeGrantsContacts", () => {
  it("grants only on an exact scope token match", () => {
    expect(scopeGrantsCalendar(`openid ${CALENDAR_SCOPE} email`)).toBe(true);
    expect(scopeGrantsContacts(`openid ${CONTACTS_SCOPE}`)).toBe(true);
  });

  it("a near-miss token (prefix/suffix variant) must NOT grant", () => {
    // Substring matching would wrongly grant these — the check must be
    // whole-token equality after whitespace split.
    expect(scopeGrantsCalendar(`${CALENDAR_SCOPE}.extra`)).toBe(false);
    expect(scopeGrantsCalendar("https://www.googleapis.com/auth/calendar")).toBe(false);
    expect(scopeGrantsContacts("https://www.googleapis.com/auth/contacts.readonly")).toBe(false);
    expect(scopeGrantsContacts(`x${CONTACTS_SCOPE}`)).toBe(false);
  });

  it("null / undefined / empty scope strings grant nothing", () => {
    expect(scopeGrantsCalendar(null)).toBe(false);
    expect(scopeGrantsCalendar(undefined)).toBe(false);
    expect(scopeGrantsContacts("")).toBe(false);
  });
});

describe("signState / verifyState", () => {
  it("round-trips the user id", async () => {
    const state = await signState("user-123");
    await expect(verifyState(state)).resolves.toBe("user-123");
  });

  it("rejects a tampered signature", async () => {
    const state = await signState("user-123");
    const [payload, sig] = state.split(".");
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await expect(verifyState(`${payload}.${flipped}`)).rejects.toThrow("Invalid state signature");
  });

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const stateA = await signState("user-a");
    const stateB = await signState("user-b");
    const forged = `${stateB.split(".")[0]}.${stateA.split(".")[1]}`;
    await expect(verifyState(forged)).rejects.toThrow("Invalid state signature");
  });

  it("rejects malformed state with no dot separator", async () => {
    await expect(verifyState("no-dot-here")).rejects.toThrow("Malformed state");
    await expect(verifyState("")).rejects.toThrow("Malformed state");
  });

  it("rejects an expired state (TTL elapsed)", async () => {
    // Negative TTL puts `e` in the past; the signature is still valid so
    // this exercises the expiry branch specifically.
    const state = await signState("user-123", -10);
    await expect(verifyState(state)).rejects.toThrow("State expired");
  });

  it("rejects a state signed under a different secret", async () => {
    const state = await signState("user-123");
    process.env.SUPABASE_SERVICE_ROLE_KEY = "rotated-secret";
    await expect(verifyState(state)).rejects.toThrow("Invalid state signature");
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is unset", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(signState("user-123")).rejects.toThrow(
      "SUPABASE_SERVICE_ROLE_KEY is not configured",
    );
    await expect(verifyState("a.b")).rejects.toThrow("SUPABASE_SERVICE_ROLE_KEY is not configured");
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the Google authorize URL with the full param contract", () => {
    const url = new URL(buildAuthorizeUrl("https://app.example/cb", "state-abc"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(GMAIL_SCOPES.join(" "));
    expect(url.searchParams.get("access_type")).toBe("offline");
    // Forces the account picker AND re-consent so Google returns a refresh_token.
    expect(url.searchParams.get("prompt")).toBe("select_account consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("login_hint")).toBeNull();
  });

  it("includes login_hint only when provided", () => {
    const url = new URL(buildAuthorizeUrl("https://app.example/cb", "s", "person@example.com"));
    expect(url.searchParams.get("login_hint")).toBe("person@example.com");
  });

  it("throws when GOOGLE_OAUTH_CLIENT_ID is unset", () => {
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    expect(() => buildAuthorizeUrl("https://app.example/cb", "s")).toThrow(
      "GOOGLE_OAUTH_CLIENT_ID is not configured",
    );
  });
});

describe("exchangeCode", () => {
  it("POSTs the authorization_code grant with all credentials and parses the response", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = input.toString();
        capturedBody = String(init?.body);
        return new Response(
          JSON.stringify({
            access_token: "at-1",
            refresh_token: "rt-1",
            expires_in: 3600,
            scope: "openid",
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }),
    );

    const tokens = await exchangeCode("the-code", "https://app.example/cb");
    expect(capturedUrl).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(capturedBody);
    expect(body.get("code")).toBe("the-code");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe("https://app.example/cb");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(tokens.access_token).toBe("at-1");
    expect(tokens.refresh_token).toBe("rt-1");
  });

  it("non-OK response throws with status and body truncated to 500 chars", async () => {
    const longBody = "x".repeat(1000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(longBody, { status: 400 })),
    );
    await expect(exchangeCode("c", "https://app.example/cb")).rejects.toThrow(
      `Token exchange failed 400: ${"x".repeat(500)}`,
    );
  });

  it("throws before any fetch when client credentials are unset", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    await expect(exchangeCode("c", "https://app.example/cb")).rejects.toThrow(
      "GOOGLE_OAUTH_CLIENT_SECRET is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("refreshAccessToken", () => {
  it("POSTs the refresh_token grant with app credentials", async () => {
    let capturedBody = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedBody = String(init?.body);
        return new Response(
          JSON.stringify({
            access_token: "at-2",
            expires_in: 3599,
            scope: "openid",
            token_type: "Bearer",
          }),
          { status: 200 },
        );
      }),
    );

    const tokens = await refreshAccessToken("rt-secret");
    const body = new URLSearchParams(capturedBody);
    expect(body.get("refresh_token")).toBe("rt-secret");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(tokens.access_token).toBe("at-2");
  });

  it("non-OK response throws with status and truncated body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })),
    );
    await expect(refreshAccessToken("rt")).rejects.toThrow(
      'Token refresh failed 400: {"error":"invalid_grant"}',
    );
  });
});

describe("revokeGoogleOAuthForAccount", () => {
  function stubRevokeFetch(status: number) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response("", { status }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("prefers the refresh token over the access token when both exist", async () => {
    fake.onRpc("get_gmail_oauth_tokens", () => ({
      data: [{ access_token: "at", refresh_token: "rt", token_expires_at: "2026-01-01" }],
    }));
    const fetchMock = stubRevokeFetch(200);
    await revokeGoogleOAuthForAccount("acc-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0].toString());
    expect(url.searchParams.get("token")).toBe("rt");
    // Token fetch used the encrypted-token RPC with the server-held key.
    expect(fake.calls.rpcs).toEqual([
      { fn: "get_gmail_oauth_tokens", args: { p_account_id: "acc-1", p_key: "test-enc-key" } },
    ]);
  });

  it("falls back to the access token when refresh token is missing", async () => {
    fake.onRpc("get_gmail_oauth_tokens", () => ({
      data: [{ access_token: "at", refresh_token: null, token_expires_at: "2026-01-01" }],
    }));
    const fetchMock = stubRevokeFetch(200);
    await revokeGoogleOAuthForAccount("acc-1");
    const url = new URL(fetchMock.mock.calls[0][0].toString());
    expect(url.searchParams.get("token")).toBe("at");
  });

  it("returns silently without calling Google when the RPC errors or finds no rows", async () => {
    const fetchMock = stubRevokeFetch(200);
    fake.onRpc("get_gmail_oauth_tokens", () => ({ error: { message: "boom" } }));
    await revokeGoogleOAuthForAccount("acc-1");
    fake.onRpc("get_gmail_oauth_tokens", () => ({ data: [] }));
    await revokeGoogleOAuthForAccount("acc-1");
    fake.onRpc("get_gmail_oauth_tokens", () => ({
      data: [{ access_token: null, refresh_token: null, token_expires_at: "2026-01-01" }],
    }));
    await revokeGoogleOAuthForAccount("acc-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tolerates Google's 400 (already-revoked token)", async () => {
    fake.onRpc("get_gmail_oauth_tokens", () => ({
      data: [{ access_token: "at", refresh_token: "rt", token_expires_at: "2026-01-01" }],
    }));
    stubRevokeFetch(400);
    await expect(revokeGoogleOAuthForAccount("acc-1")).resolves.toBeUndefined();
  });

  it("throws on a non-400 Google failure so the caller can log it", async () => {
    fake.onRpc("get_gmail_oauth_tokens", () => ({
      data: [{ access_token: "at", refresh_token: "rt", token_expires_at: "2026-01-01" }],
    }));
    stubRevokeFetch(500);
    await expect(revokeGoogleOAuthForAccount("acc-1")).rejects.toThrow(
      "Google revoke returned 500",
    );
  });

  it("throws before any RPC when EMAIL_ENC_KEY is unset", async () => {
    delete process.env.EMAIL_ENC_KEY;
    await expect(revokeGoogleOAuthForAccount("acc-1")).rejects.toThrow(
      "EMAIL_ENC_KEY is not configured",
    );
    expect(fake.calls.rpcs).toHaveLength(0);
  });
});
