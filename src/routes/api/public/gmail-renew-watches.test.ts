// Contract for the watch-renewal cron. The fake applies writes here so the
// post-renewal "still near expiry" re-read sees what the renewal actually
// wrote — which is the only way to tell a successful renewal from one that
// merely returned 200.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { Route } from "./gmail-renew-watches";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const ensureWatch = vi.hoisted(() => vi.fn<typeof import("@/lib/gmail.server").ensureWatch>());
vi.mock("@/lib/gmail.server", () => ({ ensureWatch }));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const HOUR = 60 * 60 * 1000;
const FRESH_EXPIRATION = NOW + 7 * 24 * HOUR;

type RenewBody = {
  ok: boolean;
  count?: number;
  succeeded?: number;
  failed?: number;
  stillExpiring?: number;
  run_id?: string;
  error?: string;
};

function account(over: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    email_address: "owner@example.com",
    needs_reconnect: false,
    history_id: "1000",
    // Inside the 72h renewal window.
    watch_expiration: new Date(NOW + 12 * HOUR).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  ensureWatch.mockResolvedValue({ historyId: "9001", expiration: String(FRESH_EXPIRATION) });
});

describe("selection", () => {
  it("renews an account whose watch expires inside the 72h window", async () => {
    fake.seed("gmail_accounts", [account()]);

    const { status, body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      count: 1,
      succeeded: 1,
      failed: 0,
      stillExpiring: 0,
      run_id: RUN_ID,
    });
    expect(ensureWatch).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it("renews an account that has no watch at all", async () => {
    fake.seed("gmail_accounts", [account({ watch_expiration: null })]);

    const { body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(body).toMatchObject({ count: 1, succeeded: 1 });
  });

  it("leaves an account whose watch is comfortably in the future alone", async () => {
    fake.seed("gmail_accounts", [
      account({ watch_expiration: new Date(NOW + 6 * 24 * HOUR).toISOString() }),
    ]);

    const { body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(ensureWatch).not.toHaveBeenCalled();
    expect(body).toMatchObject({ count: 0, stillExpiring: 0 });
  });

  it("never renews a dead-OAuth account", async () => {
    fake.seed("gmail_accounts", [account({ needs_reconnect: true })]);

    const { body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(ensureWatch).not.toHaveBeenCalled();
    expect(body).toMatchObject({ count: 0 });
  });

  it("skips the near-expiry re-read entirely when nothing needed renewing", async () => {
    const { body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(body).toMatchObject({ count: 0, stillExpiring: 0 });
    expect(fake.calls.selects.filter((s) => s.table === "gmail_accounts")).toHaveLength(1);
  });

  it("answers GET with 405 rather than renewing", async () => {
    const res = await handler(
      Route,
      "GET",
    )({
      request: cronRequest("gmail-renew-watches"),
      params: {},
    });

    expect(res.status).toBe(405);
    expect(fake.calls.selects).toStrictEqual([]);
  });
});

describe("what a renewal writes", () => {
  it("refreshes the expiration and leaves an existing history cursor untouched", async () => {
    fake.seed("gmail_accounts", [account()]);

    await callCron<RenewBody>(Route, "gmail-renew-watches");

    const updates = writesTo(fake, "updates", "gmail_accounts");
    expect(updates.map((u) => u.payload)).toStrictEqual([
      { watch_expiration: new Date(FRESH_EXPIRATION).toISOString() },
      { history_id: "9001" },
    ]);
    expect(updates[1]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: ACCOUNT_ID, extra: undefined },
      { op: "is", col: "history_id", value: null, extra: undefined },
    ]);
    // The `is null` guard means the stored cursor survives the renewal.
    expect(fake.rows("gmail_accounts")[0]).toMatchObject({
      history_id: "1000",
      watch_expiration: new Date(FRESH_EXPIRATION).toISOString(),
    });
  });

  it("seeds the history cursor for an account that has none", async () => {
    fake.seed("gmail_accounts", [account({ history_id: null })]);

    await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(fake.rows("gmail_accounts")[0]).toMatchObject({ history_id: "9001" });
  });

  it("writes no update at all when ensureWatch declines (no topic configured)", async () => {
    fake.seed("gmail_accounts", [account()]);
    ensureWatch.mockResolvedValue(null);

    const { body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(writesTo(fake, "updates", "gmail_accounts")).toStrictEqual([]);
    // A declined renewal still counts as "ok" — nothing went wrong, there is
    // simply no push channel to arm.
    expect(body).toMatchObject({ succeeded: 1, failed: 0, stillExpiring: 1 });
  });

  it("summarises the pass in pubsub_events", async () => {
    fake.seed("gmail_accounts", [account()]);

    await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toStrictEqual([
      {
        event_type: "watch_renew",
        accounts_matched: 1,
        synced_count: 1,
        error: null,
        details: "Renewed 1/1; 0 still near-expiry",
      },
    ]);
  });
});

describe("failure handling", () => {
  it("returns a redacted 500 when the account query fails", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "relation does not exist" }));

    const { status, body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(status).toBe(500);
    // The message is deliberately generic — the real one is in the logs only.
    expect(body).toStrictEqual({ ok: false, error: "Query failed" });
  });

  it("counts a failed renewal, keeps going, and alerts on the still-expiring account", async () => {
    fake.seed("gmail_accounts", [
      account(),
      account({ id: "22222222-2222-4222-8222-222222222222", email_address: "b@example.com" }),
    ]);
    ensureWatch
      .mockRejectedValueOnce(new Error("watch topic permission denied"))
      .mockResolvedValueOnce({ historyId: "9002", expiration: String(FRESH_EXPIRATION) });

    const { status, body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(status).toBe(200);
    expect(body).toMatchObject({ count: 2, succeeded: 1, failed: 1, stillExpiring: 1 });
    const inserts = writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload);
    expect(inserts).toContainEqual({
      event_type: "watch_renew_failed",
      email_address: "owner@example.com",
      details: `Watch expiration ${new Date(NOW + 12 * HOUR).toISOString()} still inside 24h after renewal pass`,
    });
    expect(inserts).toContainEqual({
      event_type: "watch_renew",
      accounts_matched: 2,
      synced_count: 1,
      error: "watch topic permission denied",
      details: "Renewed 1/2; 1 still near-expiry",
    });
  });

  it("caps the error summary at five messages", async () => {
    fake.seed(
      "gmail_accounts",
      Array.from({ length: 7 }, (_, i) => ({
        id: `0000000${i}-0000-4000-8000-000000000000`,
        email_address: `a${i}@example.com`,
        needs_reconnect: false,
        watch_expiration: new Date(NOW + 12 * HOUR).toISOString(),
      })),
    );
    ensureWatch.mockImplementation(async () => {
      throw new Error("nope");
    });

    const { body } = await callCron<RenewBody>(Route, "gmail-renew-watches");

    expect(body).toMatchObject({ count: 7, failed: 7 });
    const summary = writesTo(fake, "inserts", "pubsub_events")
      .map((w) => w.payload as { event_type: string; error: string | null })
      .find((p) => p.event_type === "watch_renew");
    expect(summary?.error).toBe("nope; nope; nope; nope; nope");
  });
});
