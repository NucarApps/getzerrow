// getAccessToken flow tests. The module keeps per-account in-flight refresh
// promises in module scope (`inFlightRefresh`), so every test gets a fresh
// module instance via vi.resetModules() + dynamic import.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake } from "./__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
// Static vi.mock still applies to dynamically imported module instances.
// Methods are deferred into bodies so the hoisted factory never reads `fake`.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));

type OAuthModule = typeof import("./google-oauth.server");

const ACC = "acc-1";
const ENV_KEYS = ["EMAIL_ENC_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
let savedEnv: Record<string, string | undefined>;

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function seedAccount(row: Record<string, unknown> = {}) {
  fake.seed("gmail_accounts", [
    { id: ACC, needs_reconnect: false, last_oauth_error: null, ...row },
  ]);
}

function tokensRpc(row: {
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string;
}) {
  fake.onRpc("get_gmail_oauth_tokens", () => ({ data: [row] }));
}

function refreshResponse(accessToken = "new-at"): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: 3600,
      scope: "openid",
      token_type: "Bearer",
    }),
    { status: 200 },
  );
}

async function importSut(): Promise<OAuthModule> {
  return import("./google-oauth.server");
}

beforeEach(() => {
  vi.resetModules();
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.EMAIL_ENC_KEY = "test-enc-key";
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  fake.reset();
  seedAccount();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("getAccessToken", () => {
  it("throws before any query when EMAIL_ENC_KEY is unset", async () => {
    delete process.env.EMAIL_ENC_KEY;
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow("EMAIL_ENC_KEY is not configured");
    expect(fake.calls.selects).toHaveLength(0);
    expect(fake.calls.rpcs).toHaveLength(0);
  });

  it("short-circuits with NeedsReconnectError when the account is already flagged", async () => {
    seedAccount({ needs_reconnect: true, last_oauth_error: "previous failure" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow(mod.NeedsReconnectError);
    await expect(mod.getAccessToken(ACC)).rejects.toThrow("previous failure");
    // No token RPC and no Google roundtrip until the user reconnects.
    expect(fake.calls.rpcs).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing refresh token marks needs_reconnect and throws NeedsReconnectError", async () => {
    tokensRpc({ access_token: "at", refresh_token: null, token_expires_at: futureIso(3600_000) });
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow(mod.NeedsReconnectError);
    expect(fake.calls.updates).toHaveLength(1);
    const upd = fake.calls.updates[0];
    expect(upd.table).toBe("gmail_accounts");
    expect(upd.payload).toMatchObject({ needs_reconnect: true });
    expect(upd.filters).toEqual([{ op: "eq", col: "id", value: ACC }]);
  });

  it("token fetch RPC error is surfaced", async () => {
    fake.onRpc("get_gmail_oauth_tokens", () => ({ error: { message: "decrypt failed" } }));
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow(
      "OAuth token fetch failed: decrypt failed",
    );
  });

  it("empty RPC result means the account row is gone", async () => {
    fake.onRpc("get_gmail_oauth_tokens", () => ({ data: [] }));
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow("Gmail account not found");
  });

  it("returns the stored token without any fetch when it has >2min of life left", async () => {
    tokensRpc({
      access_token: "at",
      refresh_token: "rt",
      token_expires_at: futureIso(10 * 60_000),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).resolves.toBe("at");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expired token triggers exactly one refresh and persists via set_gmail_oauth_tokens with p_refresh_token: ''", async () => {
    tokensRpc({ access_token: "at", refresh_token: "rt", token_expires_at: futureIso(-1000) });
    const fetchMock = vi.fn(async () => refreshResponse("new-at"));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).resolves.toBe("new-at");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const setCall = fake.calls.rpcs.find((r) => r.fn === "set_gmail_oauth_tokens");
    expect(setCall).toBeDefined();
    expect(setCall!.args).toMatchObject({
      p_account_id: ACC,
      p_access_token: "new-at",
      // Empty string preserves the existing encrypted refresh token — the
      // refresh grant does not rotate it. Regression-guard this contract.
      p_refresh_token: "",
      p_key: "test-enc-key",
    });
    expect(typeof setCall!.args.p_token_expires_at).toBe("string");
  });

  it("coalesces concurrent callers into one refresh fetch and clears the in-flight map after", async () => {
    tokensRpc({ access_token: "at", refresh_token: "rt", token_expires_at: futureIso(-1000) });
    const resolvers: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const mod = await importSut();

    const p1 = mod.getAccessToken(ACC);
    const p2 = mod.getAccessToken(ACC);
    // Let both callers pass the DB reads and reach the in-flight map before
    // the (single) refresh resolves.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolvers[0](refreshResponse("shared-at"));
    await expect(Promise.all([p1, p2])).resolves.toEqual(["shared-at", "shared-at"]);

    // Map is cleared: a later call (token still expired in the fake) must
    // start a fresh refresh instead of reusing a settled promise.
    const p3 = mod.getAccessToken(ACC);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvers[1](refreshResponse("later-at"));
    await expect(p3).resolves.toBe("later-at");
  });

  it("invalid_grant flips needs_reconnect and throws NeedsReconnectError", async () => {
    tokensRpc({ access_token: "at", refresh_token: "rt", token_expires_at: futureIso(-1000) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })),
    );
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow(mod.NeedsReconnectError);
    expect(fake.calls.updates).toHaveLength(1);
    expect(fake.calls.updates[0].payload).toMatchObject({ needs_reconnect: true });
  });

  it("invalid_client throws AppCredentialError WITHOUT flagging the account", async () => {
    // App-wide misconfig (rotated client secret) must not permanently disable
    // a healthy account — reconnecting could not fix it anyway.
    tokensRpc({ access_token: "at", refresh_token: "rt", token_expires_at: futureIso(-1000) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"invalid_client"}', { status: 401 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow(mod.AppCredentialError);
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("transient 500 from Google is rethrown as-is with no reconnect flag", async () => {
    tokensRpc({ access_token: "at", refresh_token: "rt", token_expires_at: futureIso(-1000) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("server error", { status: 500 })),
    );
    const mod = await importSut();
    const err = await mod.getAccessToken(ACC).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("Token refresh failed 500");
    expect(err).not.toBeInstanceOf(mod.NeedsReconnectError);
    expect(fake.calls.updates).toHaveLength(0);
  });

  it("set_gmail_oauth_tokens RPC error fails the refresh", async () => {
    tokensRpc({ access_token: "at", refresh_token: "rt", token_expires_at: futureIso(-1000) });
    fake.onRpc("set_gmail_oauth_tokens", () => ({ error: { message: "write denied" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => refreshResponse()),
    );
    const mod = await importSut();
    await expect(mod.getAccessToken(ACC)).rejects.toThrow(
      "OAuth token update failed: write denied",
    );
  });
});
