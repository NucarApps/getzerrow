// Mobile Gmail connect core (mobile-gmail.server.ts). The Swift app hands
// off Google OAuth tokens here, so this module is the mobile mirror of the
// web connect flow and every contract below is one the app depends on:
//
//   * either shape of handoff works — a direct access/refresh token pair,
//     or a server_auth_code the backend exchanges (with an EMPTY redirect
//     uri, which is what native flows require) — and a handoff missing a
//     usable token pair throws before any RPC runs,
//   * the address is resolved from Google when the app did not send one,
//     and is lowercased both in the RPC payload and in the response,
//   * expires_in is clamped to 24h and defaults to 1h, since it arrives
//     from the client and feeds a token-expiry column,
//   * p_user_id comes from the authenticated caller, never the payload,
//   * the watch and both backfills are best-effort: each failure is logged
//     and the connect still succeeds, because the app is blocked on this
//     call and sync has its own fallbacks. A failing watch must NOT leave
//     the history_id update behind either.
//
// getCategorizationRules pins the folder→filters grouping and the
// user_id scoping of the folders read.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

vi.mock("./email-enc-key", () => ({ emailEncKey: () => "enc-key" }));

const exchangeCode = vi.fn();
const fetchUserEmail = vi.fn(async () => "Fetched@Example.COM");
vi.mock("./google-oauth.server", () => ({
  exchangeCode: (...a: unknown[]) => exchangeCode(...(a as [])),
  fetchUserEmail: (...a: unknown[]) => fetchUserEmail(...(a as [])),
}));

const ensureWatch = vi.fn(
  async (): Promise<{ historyId: string; expiration: string } | null> => null,
);
vi.mock("./gmail.server", () => ({ ensureWatch: (...a: unknown[]) => ensureWatch(...(a as [])) }));

const backfillRecent = vi.fn(async () => {});
const startBackfillJob = vi.fn(async () => {});
vi.mock("./sync.server", () => ({
  backfillRecent: (...a: unknown[]) => backfillRecent(...(a as [])),
  startBackfillJob: (...a: unknown[]) => startBackfillJob(...(a as [])),
}));

const logAudit = vi.fn();
const logError = vi.fn();
vi.mock("./log.server", () => ({
  logAudit: (...a: unknown[]) => logAudit(...(a as [])),
  logError: (...a: unknown[]) => logError(...(a as [])),
}));

const { connectGmailCore, getCategorizationRules } = await import("./mobile-gmail.server");

const USER = "user-1";
const ACCOUNT = "account-1";
const TOKENS = { access_token: "at", refresh_token: "rt", email_address: "Person@Example.COM" };

function rpcArgs() {
  return fake.calls.rpcs[0]?.args as Record<string, unknown> | undefined;
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
  fetchUserEmail.mockResolvedValue("Fetched@Example.COM");
  ensureWatch.mockResolvedValue(null);
  backfillRecent.mockResolvedValue(undefined);
  startBackfillJob.mockResolvedValue(undefined);
  fake.onRpc("upsert_gmail_oauth_account", () => ({ data: ACCOUNT }));
});

describe("connectGmailCore token handoff", () => {
  it("stores a direct token pair under the authenticated user, address lowercased", async () => {
    const res = await connectGmailCore(USER, TOKENS);

    expect(res).toEqual({ account_id: ACCOUNT, email_address: "person@example.com" });
    expect(rpcArgs()).toMatchObject({
      p_user_id: USER,
      p_email_address: "person@example.com",
      p_access_token: "at",
      p_refresh_token: "rt",
      p_key: "enc-key",
    });
    // The app never sends an address to look up rules by, so no extra call.
    expect(fetchUserEmail).not.toHaveBeenCalled();
  });

  it("exchanges a server auth code with an empty redirect uri", async () => {
    exchangeCode.mockResolvedValue({
      access_token: "exchanged-at",
      refresh_token: "exchanged-rt",
      expires_in: 900,
    });

    const res = await connectGmailCore(USER, { server_auth_code: "code-123" });

    expect(exchangeCode).toHaveBeenCalledWith("code-123", "");
    expect(rpcArgs()).toMatchObject({
      p_access_token: "exchanged-at",
      p_refresh_token: "exchanged-rt",
    });
    // Address came from Google, since the code exchange carried none.
    expect(fetchUserEmail).toHaveBeenCalledWith("exchanged-at");
    expect(res.email_address).toBe("fetched@example.com");
  });

  it("keeps the caller's refresh token when the code exchange returns none", async () => {
    // Google omits refresh_token on re-consent; dropping the stored one
    // would silently un-connect the account on the next refresh.
    exchangeCode.mockResolvedValue({ access_token: "exchanged-at", expires_in: 900 });
    await connectGmailCore(USER, { server_auth_code: "code", refresh_token: "kept-rt" });
    expect(rpcArgs()).toMatchObject({ p_refresh_token: "kept-rt" });
  });

  it("rejects a handoff with no usable token pair, before any RPC", async () => {
    await expect(connectGmailCore(USER, { access_token: "at" })).rejects.toThrow(
      /Missing Google tokens/,
    );
    await expect(connectGmailCore(USER, {})).rejects.toThrow(/Missing Google tokens/);
    expect(fake.calls.rpcs).toEqual([]);
  });

  it("fails the connect when the upsert RPC errors or returns no id", async () => {
    fake.onRpc("upsert_gmail_oauth_account", () => ({ error: { message: "rpc down" } }));
    await expect(connectGmailCore(USER, TOKENS)).rejects.toThrow(
      "Failed to save account: rpc down",
    );

    fake.onRpc("upsert_gmail_oauth_account", () => ({ data: null }));
    await expect(connectGmailCore(USER, TOKENS)).rejects.toThrow("Failed to save account:");
    expect(ensureWatch).not.toHaveBeenCalled();
  });
});

describe("connectGmailCore token expiry", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("defaults to one hour when the app sends no expires_in", async () => {
    await connectGmailCore(USER, TOKENS);
    expect(rpcArgs()?.p_token_expires_at).toBe("2026-01-01T01:00:00.000Z");
  });

  it("honours a sane expires_in", async () => {
    await connectGmailCore(USER, { ...TOKENS, expires_in: 120 });
    expect(rpcArgs()?.p_token_expires_at).toBe("2026-01-01T00:02:00.000Z");
  });

  it("clamps a client-supplied expires_in to 24 hours", async () => {
    // expires_in arrives from the device; an absurd value would park a
    // dead token as "valid" for as long as the client asked.
    await connectGmailCore(USER, { ...TOKENS, expires_in: 60 * 60 * 24 * 365 });
    expect(rpcArgs()?.p_token_expires_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("falls back to one hour for a zero or negative expires_in", async () => {
    await connectGmailCore(USER, { ...TOKENS, expires_in: 0 });
    expect(rpcArgs()?.p_token_expires_at).toBe("2026-01-01T01:00:00.000Z");
    fake.reset();
    fake.onRpc("upsert_gmail_oauth_account", () => ({ data: ACCOUNT }));
    await connectGmailCore(USER, { ...TOKENS, expires_in: -5 });
    expect(rpcArgs()?.p_token_expires_at).toBe("2026-01-01T01:00:00.000Z");
  });
});

describe("connectGmailCore post-connect work", () => {
  it("records the watch cursor when the watch starts", async () => {
    ensureWatch.mockResolvedValue({ historyId: "h-9", expiration: "1767225600000" });

    await connectGmailCore(USER, TOKENS);

    expect(fake.calls.updates[0]).toMatchObject({
      table: "gmail_accounts",
      payload: {
        history_id: "h-9",
        watch_expiration: new Date(1767225600000).toISOString(),
      },
      filters: [{ op: "eq", col: "id", value: ACCOUNT }],
    });
  });

  it("writes nothing when the watch call returns no watch", async () => {
    ensureWatch.mockResolvedValue(null);
    await connectGmailCore(USER, TOKENS);
    expect(fake.calls.updates).toEqual([]);
  });

  it("still connects when the watch, the light backfill and the job all fail", async () => {
    ensureWatch.mockRejectedValue(new Error("watch boom"));
    backfillRecent.mockRejectedValue(new Error("backfill boom"));
    startBackfillJob.mockRejectedValue(new Error("job boom"));

    const res = await connectGmailCore(USER, TOKENS);

    expect(res.account_id).toBe(ACCOUNT);
    // A failing watch must not leave a cursor update behind.
    expect(fake.calls.updates).toEqual([]);
    expect(logError.mock.calls.map((c) => c[0])).toEqual([
      "gmail.mobile_connect.ensure_watch_failed",
      "gmail.mobile_connect.backfill_failed",
      "gmail.mobile_connect.start_backfill_failed",
    ]);
  });

  it("runs the light backfill before the deeper background job", async () => {
    await connectGmailCore(USER, TOKENS);
    expect(backfillRecent).toHaveBeenCalledWith(ACCOUNT, USER, 30);
    expect(startBackfillJob).toHaveBeenCalledWith(ACCOUNT, USER, { months: 6 });
    expect(backfillRecent.mock.invocationCallOrder[0]!).toBeLessThan(
      startBackfillJob.mock.invocationCallOrder[0]!,
    );
  });

  it("audits the connect as coming from mobile", async () => {
    await connectGmailCore(USER, TOKENS);
    expect(logAudit).toHaveBeenCalledWith("gmail.connected", {
      user_id: USER,
      account_id: ACCOUNT,
      source: "mobile",
    });
  });

  it("never puts a raw token in the audit or error logs", async () => {
    ensureWatch.mockRejectedValue(new Error("watch boom"));
    await connectGmailCore(USER, TOKENS);
    const logged = JSON.stringify([logAudit.mock.calls, logError.mock.calls]);
    expect(logged).not.toContain("rt");
    expect(logged).not.toContain("enc-key");
  });
});

describe("getCategorizationRules", () => {
  it("returns folders in priority order with their filters attached", async () => {
    fake.seedRaw("folders", [
      { id: "f1", user_id: USER, name: "Work", priority: 1, auto_archive: false, color: "#fff" },
      { id: "f2", user_id: USER, name: "Bills", priority: 0, auto_archive: true, color: null },
      // A folder belonging to someone else must not reach the mobile app.
      { id: "f3", user_id: "other-user", name: "Theirs", priority: 2 },
    ]);
    fake.seedRaw("folder_filters", [
      { folder_id: "f1", field: "from", op: "contains", value: "acme" },
      { folder_id: "f1", field: "subject", op: "eq", value: "Report" },
    ]);

    const rules = await getCategorizationRules(USER);

    expect(rules.map((r) => r.name)).toEqual(["Bills", "Work"]);
    expect(rules[1]?.filters).toEqual([
      { field: "from", op: "contains", value: "acme" },
      { field: "subject", op: "eq", value: "Report" },
    ]);
    // A folder with no filters gets an empty list, never undefined — the
    // Swift decoder requires the key.
    expect(rules[0]?.filters).toEqual([]);
  });

  it("scopes the folders read to the caller", async () => {
    await getCategorizationRules(USER);
    expect(fake.calls.selects[0]).toMatchObject({
      table: "folders",
      filters: [{ op: "eq", col: "user_id", value: USER }],
    });
  });

  it("skips the filters query entirely when the user has no folders", async () => {
    expect(await getCategorizationRules(USER)).toEqual([]);
    expect(fake.calls.selects.map((s) => s.table)).toEqual(["folders"]);
  });

  it("throws when the folders read fails rather than reporting no rules", async () => {
    fake.onSelect("folders", () => ({ message: "read failed" }));
    await expect(getCategorizationRules(USER)).rejects.toThrow(
      "Failed to load folders: read failed",
    );
  });
});
