// Contract for the per-user Google OAuth callback. It is hit by Google, so it
// cannot carry the cron secret and the auth sweep skips it: the signed,
// expiring `state` parameter IS its authentication, and the redirect it
// issues plus the account row it writes are what the rest of the app relies
// on. Both are pinned here, along with every way the exchange can go wrong.
//
// scopeGrantsCalendar/scopeGrantsContacts stay real — the point of the two
// scope branches is which OAuth scope string produces which flag.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  writesTo,
} from "@/lib/__fixtures__/supabase-fake";
import { CALENDAR_SCOPE, CONTACTS_SCOPE } from "@/lib/google-oauth.server";
import { handler } from "./__fixtures__/route-harness";
import { Route } from "./google-oauth-callback";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const oauth = vi.hoisted(() => ({
  exchangeCode: vi.fn<typeof import("@/lib/google-oauth.server").exchangeCode>(),
  fetchUserEmail: vi.fn<typeof import("@/lib/google-oauth.server").fetchUserEmail>(),
  getRedirectUri: vi.fn<typeof import("@/lib/google-oauth.server").getRedirectUri>(),
  verifyState: vi.fn<typeof import("@/lib/google-oauth.server").verifyState>(),
  clearNeedsReconnect: vi.fn<typeof import("@/lib/google-oauth.server").clearNeedsReconnect>(),
}));
vi.mock("@/lib/google-oauth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/google-oauth.server")>();
  return { ...actual, ...oauth };
});

const ensureWatch = vi.hoisted(() => vi.fn<typeof import("@/lib/gmail.server").ensureWatch>());
vi.mock("@/lib/gmail.server", () => ({ ensureWatch }));

const GET = handler(Route, "GET");

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const ENC_KEY = "test-encryption-key";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

async function callback(params: Record<string, string>): Promise<Response> {
  const url = new URL("https://app.atzro.test/api/public/google-oauth-callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return GET({ request: new Request(url), params: {} });
}

function tokens(scope: string) {
  return {
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    scope,
    token_type: "Bearer",
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("EMAIL_ENC_KEY", ENC_KEY);
  oauth.verifyState.mockResolvedValue(USER_ID);
  oauth.getRedirectUri.mockReturnValue("https://app.atzro.test/api/public/google-oauth-callback");
  oauth.exchangeCode.mockResolvedValue(tokens(GMAIL_SCOPE));
  oauth.fetchUserEmail.mockResolvedValue("Owner@Example.com");
  oauth.clearNeedsReconnect.mockResolvedValue();
  ensureWatch.mockResolvedValue(null);
  fake.onRpc("upsert_gmail_oauth_account", () => ({ data: ACCOUNT_ID }));
});

describe("refusals", () => {
  it("sends the user back to settings with the provider's error", async () => {
    const res = await callback({ error: "access_denied" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?error=access_denied");
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("escapes the provider's error rather than reflecting it verbatim", async () => {
    const res = await callback({ error: "bad thing&next=/evil" });

    expect(res.headers.get("Location")).toBe("/settings?error=bad%20thing%26next%3D%2Fevil");
  });

  it.each([
    ["no code", { state: "signed-state" }],
    ["no state", { code: "auth-code" }],
  ])("refuses a callback with %s", async (_name, params) => {
    const res = await callback(params);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Missing code or state");
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a tampered or expired state before exchanging anything", async () => {
    oauth.verifyState.mockRejectedValue(new Error("bad signature"));

    const res = await callback({ code: "auth-code", state: "tampered" });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      "Invalid or expired authorization state. Please try connecting again.",
    );
    expect(oauth.exchangeCode).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
    expect(fake.calls.rpcs).toStrictEqual([]);
  });

  it("asks the user to re-consent when Google returns no refresh token", async () => {
    oauth.exchangeCode.mockResolvedValue({ ...tokens(GMAIL_SCOPE), refresh_token: undefined });

    const res = await callback({ code: "auth-code", state: "signed-state" });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("myaccount.google.com/permissions");
    expect(fake.calls.rpcs).toStrictEqual([]);
  });

  it("refuses to store tokens without the encryption key", async () => {
    vi.stubEnv("EMAIL_ENC_KEY", undefined);

    const res = await callback({ code: "auth-code", state: "signed-state" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Server misconfigured. Please contact support.");
    expect(fake.calls.rpcs).toStrictEqual([]);
  });

  it.each([
    [
      "the upsert errors",
      () =>
        fake.onRpc("upsert_gmail_oauth_account", () => ({
          error: { message: "unique violation" },
        })),
    ],
    [
      "the upsert returns no id",
      () => fake.onRpc("upsert_gmail_oauth_account", () => ({ data: null })),
    ],
  ])("reports a generic 500 when %s", async (_name, arrange) => {
    arrange();

    const res = await callback({ code: "auth-code", state: "signed-state" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Something went wrong saving your account. Please try again.");
    expect(oauth.clearNeedsReconnect).not.toHaveBeenCalled();
  });

  it("reports a generic 500 when the token exchange throws", async () => {
    oauth.exchangeCode.mockRejectedValue(new Error("Token exchange failed 400: invalid_grant"));

    const res = await callback({ code: "auth-code", state: "signed-state" });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Something went wrong completing sign-in. Please try again.");
  });
});

describe("a successful connect", () => {
  it("stores the tokens under the lowercased address and redirects to settings", async () => {
    const res = await callback({ code: "auth-code", state: "signed-state" });

    expect(oauth.getRedirectUri).toHaveBeenCalledWith("https://app.atzro.test");
    expect(oauth.exchangeCode).toHaveBeenCalledWith(
      "auth-code",
      "https://app.atzro.test/api/public/google-oauth-callback",
    );
    expect(fake.calls.rpcs).toStrictEqual([
      {
        fn: "upsert_gmail_oauth_account",
        args: {
          p_user_id: USER_ID,
          p_email_address: "owner@example.com",
          p_access_token: "at-1",
          p_refresh_token: "rt-1",
          p_token_expires_at: new Date(NOW + 3_600_000).toISOString(),
          p_key: ENC_KEY,
        },
      },
    ]);
    expect(oauth.clearNeedsReconnect).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?connected=1");
  });

  it("records neither extra scope for a Gmail-only grant", async () => {
    await callback({ code: "auth-code", state: "signed-state" });

    expect(writesTo(fake, "updates", "gmail_accounts").map((u) => u.payload)).toStrictEqual([
      { calendar_access: false, contacts_access: false },
    ]);
    // No contacts scope: the settings banner is told so immediately rather
    // than waiting for the next reconcile to notice.
    expect(writesTo(fake, "updates", "google_sync_state").map((u) => u.payload)).toStrictEqual([
      { last_error: "missing_contacts_scope" },
    ]);
  });

  it("records both scopes and clears the stale contacts banner when granted", async () => {
    oauth.exchangeCode.mockResolvedValue(
      tokens(`${GMAIL_SCOPE} ${CALENDAR_SCOPE} ${CONTACTS_SCOPE}`),
    );

    await callback({ code: "auth-code", state: "signed-state" });

    expect(writesTo(fake, "updates", "gmail_accounts").map((u) => u.payload)).toStrictEqual([
      { calendar_access: true, contacts_access: true },
    ]);
    const syncStateUpdate = writesTo(fake, "updates", "google_sync_state")[0];
    expect(syncStateUpdate?.payload).toStrictEqual({ last_error: null });
    expect(syncStateUpdate?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: USER_ID, extra: undefined },
      { op: "eq", col: "gmail_account_id", value: ACCOUNT_ID, extra: undefined },
      {
        op: "in",
        col: "last_error",
        value: ["missing_contacts_scope", "needs_reconnect"],
        extra: undefined,
      },
    ]);
  });

  it("arms the Gmail push watch and stores its cursor and expiry", async () => {
    ensureWatch.mockResolvedValue({ historyId: "5001", expiration: String(NOW + 7 * 86_400_000) });

    await callback({ code: "auth-code", state: "signed-state" });

    expect(ensureWatch).toHaveBeenCalledWith(ACCOUNT_ID, null);
    expect(writesTo(fake, "updates", "gmail_accounts").map((u) => u.payload)).toContainEqual({
      history_id: "5001",
      watch_expiration: new Date(NOW + 7 * 86_400_000).toISOString(),
    });
  });

  it("still completes the connect when the scope bookkeeping fails", async () => {
    fake.onUpdate("gmail_accounts", () => {
      throw new Error("update exploded");
    });

    const res = await callback({ code: "auth-code", state: "signed-state" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?connected=1");
  });

  it("still completes the connect when arming the watch fails", async () => {
    ensureWatch.mockRejectedValue(new Error("Pub/Sub topic permission denied"));

    const res = await callback({ code: "auth-code", state: "signed-state" });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/settings?connected=1");
  });
});
