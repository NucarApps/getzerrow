// Contract for the reconciliation cron: which accounts a tick picks up, the
// window size it walks them with, the rotation stamp it writes BEFORE the
// walk (so a persistently-failing account cannot hog every tick), and the
// per-account result array its caller reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { Route } from "./gmail-reconcile";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const reconcileLocalInbox = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync.server").reconcileLocalInbox>(),
);
const syncReadState = vi.hoisted(() => vi.fn<typeof import("@/lib/sync.server").syncReadState>());
vi.mock("@/lib/sync.server", () => ({ reconcileLocalInbox, syncReadState }));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;

type ReconcileBody = {
  ok: boolean;
  results: Array<{ account_id: string; result?: unknown; error?: string; limit?: number }>;
  run_id?: string;
  error?: string;
};

function account(over: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    email_address: "owner@example.com",
    needs_reconnect: false,
    last_history_sync_at: new Date(NOW - 5 * MINUTE).toISOString(),
    last_reconcile_at: new Date(NOW - 60 * MINUTE).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  reconcileLocalInbox.mockResolvedValue({ checked: 12, repaired: 1 } as Awaited<
    ReturnType<typeof reconcileLocalInbox>
  >);
  syncReadState.mockResolvedValue({ marked_read: 2, marked_unread: 0, gmail_unread: 5 });
});

describe("happy path", () => {
  it("walks the account with the default window and reports its result", async () => {
    fake.seed("gmail_accounts", [account()]);

    const { status, body } = await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      run_id: RUN_ID,
      results: [
        {
          account_id: ACCOUNT_ID,
          result: {
            checked: 12,
            repaired: 1,
            readState: { marked_read: 2, marked_unread: 0, gmail_unread: 5 },
          },
          limit: 200,
        },
      ],
    });
    expect(reconcileLocalInbox).toHaveBeenCalledWith(ACCOUNT_ID, 200);
    expect(syncReadState).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("selects only live accounts and caps the tick at max_accounts", async () => {
    fake.seed("gmail_accounts", [account()]);

    await callCron<ReconcileBody>(Route, "gmail-reconcile", { max_accounts: "2" });

    const select = fake.calls.selects.find((s) => s.table === "gmail_accounts");
    expect(select?.filters).toStrictEqual([
      { op: "eq", col: "needs_reconnect", value: false, extra: undefined },
    ]);
    expect(select?.limit).toBe(2);
  });

  it("clamps max_accounts to [1, 50] and falls back to 4 for a non-numeric value", async () => {
    fake.seed("gmail_accounts", [account()]);

    await callCron<ReconcileBody>(Route, "gmail-reconcile", { max_accounts: "999" });
    await callCron<ReconcileBody>(Route, "gmail-reconcile", { max_accounts: "0" });
    await callCron<ReconcileBody>(Route, "gmail-reconcile", { max_accounts: "many" });

    expect(
      fake.calls.selects.filter((s) => s.table === "gmail_accounts").map((s) => s.limit),
    ).toStrictEqual([50, 1, 4]);
  });

  it("records the sweep for the activity panel", async () => {
    fake.seed("gmail_accounts", [account()]);

    await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toStrictEqual([
      {
        event_type: "reconcile",
        accounts_matched: 1,
        details: "Reconciled 1 account(s); 0 suspect",
      },
    ]);
  });

  it("answers GET with 405 rather than reconciling", async () => {
    const res = await handler(
      Route,
      "GET",
    )({
      request: cronRequest("gmail-reconcile"),
      params: {},
    });

    expect(res.status).toBe(405);
    expect(fake.calls.selects).toStrictEqual([]);
  });
});

describe("rotation stamp", () => {
  it("stamps last_reconcile_at BEFORE walking the account", async () => {
    fake.seed("gmail_accounts", [account()]);
    let stampedWhenWalkStarted: unknown[] = [];
    reconcileLocalInbox.mockImplementation(async () => {
      stampedWhenWalkStarted = writesTo(fake, "updates", "gmail_accounts").map((u) => u.payload);
      return { checked: 0 } as Awaited<ReturnType<typeof reconcileLocalInbox>>;
    });

    await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(stampedWhenWalkStarted).toStrictEqual([
      { last_reconcile_at: new Date(NOW).toISOString() },
    ]);
  });

  it("still stamps — and still rotates — when the walk fails", async () => {
    fake.seed("gmail_accounts", [account()]);
    reconcileLocalInbox.mockRejectedValue(new Error("Gmail 500 backend error"));

    const { status, body } = await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(status).toBe(200);
    expect(body.results).toStrictEqual([
      { account_id: ACCOUNT_ID, error: "Gmail 500 backend error", limit: 200 },
    ]);
    expect(writesTo(fake, "updates", "gmail_accounts").map((u) => u.payload)).toStrictEqual([
      { last_reconcile_at: new Date(NOW).toISOString() },
    ]);
  });
});

describe("suspect accounts get a wider window", () => {
  it("widens to 500 when the account logged a push error in the last hour", async () => {
    fake.seed("gmail_accounts", [account()]);
    fake.seedRaw("pubsub_events", [
      {
        email_address: "owner@example.com",
        error: "history 404",
        received_at: new Date(NOW - 10 * MINUTE).toISOString(),
      },
    ]);

    const { body } = await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(reconcileLocalInbox).toHaveBeenCalledWith(ACCOUNT_ID, 500);
    expect(body.results[0]).toMatchObject({ limit: 500 });
    expect(writesTo(fake, "inserts", "pubsub_events")[0]?.payload).toMatchObject({
      details: "Reconciled 1 account(s); 1 suspect",
    });
  });

  it("ignores a push error older than the one-hour window", async () => {
    fake.seed("gmail_accounts", [account()]);
    fake.seedRaw("pubsub_events", [
      {
        email_address: "owner@example.com",
        error: "history 404",
        received_at: new Date(NOW - 61 * MINUTE).toISOString(),
      },
    ]);

    await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(reconcileLocalInbox).toHaveBeenCalledWith(ACCOUNT_ID, 200);
  });

  it("widens for an account whose last history sync is over 30 minutes old", async () => {
    fake.seed("gmail_accounts", [
      account({ last_history_sync_at: new Date(NOW - 31 * MINUTE).toISOString() }),
    ]);

    await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(reconcileLocalInbox).toHaveBeenCalledWith(ACCOUNT_ID, 500);
  });

  it("does not widen for an account that has never synced (no baseline to be late against)", async () => {
    fake.seed("gmail_accounts", [account({ last_history_sync_at: null })]);

    await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(reconcileLocalInbox).toHaveBeenCalledWith(ACCOUNT_ID, 200);
  });
});

describe("failure handling", () => {
  it("returns 500 with the message when the accounts query fails", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "statement timeout" }));

    const { status, body } = await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(status).toBe(500);
    expect(body).toStrictEqual({ ok: false, error: "statement timeout" });
    expect(reconcileLocalInbox).not.toHaveBeenCalled();
  });

  it("keeps the inbox result when only the read-state diff fails", async () => {
    fake.seed("gmail_accounts", [account()]);
    syncReadState.mockRejectedValue(new Error("Gmail 503"));

    const { body } = await callCron<ReconcileBody>(Route, "gmail-reconcile");

    // readState is left undefined and therefore drops out of the JSON body —
    // the caller sees the inbox result, with no read-state key at all.
    expect(body.results).toStrictEqual([
      { account_id: ACCOUNT_ID, result: { checked: 12, repaired: 1 }, limit: 200 },
    ]);
  });

  it("carries on to the next account after one fails", async () => {
    fake.seed("gmail_accounts", [
      account(),
      account({ id: "22222222-2222-4222-8222-222222222222", email_address: "b@example.com" }),
    ]);
    reconcileLocalInbox
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ checked: 3 } as Awaited<ReturnType<typeof reconcileLocalInbox>>);

    const { body } = await callCron<ReconcileBody>(Route, "gmail-reconcile");

    expect(body.results.map((r) => r.account_id)).toStrictEqual([
      ACCOUNT_ID,
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(body.results[0]?.error).toBe("boom");
    expect(body.results[1]?.result).toStrictEqual({
      checked: 3,
      readState: { marked_read: 2, marked_unread: 0, gmail_unread: 5 },
    });
  });
});
