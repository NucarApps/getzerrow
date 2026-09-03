// Contract for the polling fallback cron: which accounts it syncs, when it
// re-arms a silent account's Gmail watch, what it records for the Sync
// activity panel, and the JSON body its caller reads.
//
// The re-arm path is the one worth pinning hard: it writes the watch
// expiration unconditionally but the history cursor ONLY when the account has
// none. Overwriting an existing cursor with the watch response's historyId
// (Gmail's current mailbox head) silently skips every message in between.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { Route } from "./gmail-poll";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const syncSinceHistory = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync.server").syncSinceHistory>(),
);
const runMessageJobs = vi.hoisted(() => vi.fn<typeof import("@/lib/sync.server").runMessageJobs>());
vi.mock("@/lib/sync.server", () => ({ syncSinceHistory, runMessageJobs }));

const ensureWatch = vi.hoisted(() => vi.fn<typeof import("@/lib/gmail.server").ensureWatch>());
vi.mock("@/lib/gmail.server", () => ({ ensureWatch }));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const HOUR = 60 * 60 * 1000;

type PollBody = {
  ok: boolean;
  count: number;
  accounts: number;
  succeeded: number;
  failed: number;
  rearmed: number;
  synced: number;
  jobs: unknown;
  run_id: string;
  error?: string;
};

/** An account that is neither silent nor due for a re-arm. */
function healthyAccount(over: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    email_address: "owner@example.com",
    watch_expiration: new Date(NOW + 5 * 24 * HOUR).toISOString(),
    last_push_at: new Date(NOW - 60_000).toISOString(),
    created_at: new Date(NOW - 30 * 24 * HOUR).toISOString(),
    needs_reconnect: false,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  syncSinceHistory.mockResolvedValue({ synced: 0 });
  runMessageJobs.mockResolvedValue({ processed: 0 } as Awaited<ReturnType<typeof runMessageJobs>>);
  ensureWatch.mockResolvedValue(null);
});

describe("happy path", () => {
  it("syncs every live account, drains the job queue and reports the tallies", async () => {
    fake.seed("gmail_accounts", [
      healthyAccount(),
      healthyAccount({
        id: "22222222-2222-4222-8222-222222222222",
        email_address: "b@example.com",
      }),
    ]);
    syncSinceHistory.mockResolvedValue({ synced: 3 });
    runMessageJobs.mockResolvedValue({ processed: 6 } as Awaited<
      ReturnType<typeof runMessageJobs>
    >);

    const { status, body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      count: 2,
      accounts: 2,
      succeeded: 2,
      failed: 0,
      rearmed: 0,
      synced: 6,
      jobs: { processed: 6 },
      run_id: RUN_ID,
    });
    expect(syncSinceHistory.mock.calls.map((c) => c[0])).toStrictEqual([
      ACCOUNT_ID,
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(runMessageJobs).toHaveBeenCalledWith(50);
  });

  it("records the run for the Sync activity panel", async () => {
    fake.seed("gmail_accounts", [healthyAccount()]);
    syncSinceHistory.mockResolvedValue({ synced: 2 });

    await callCron<PollBody>(Route, "gmail-poll");

    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toStrictEqual([
      { event_type: "poll", accounts_matched: 1, synced_count: 2, error: null },
    ]);
  });

  it("skips dead-OAuth accounts entirely — they are not even counted", async () => {
    fake.seed("gmail_accounts", [healthyAccount({ needs_reconnect: true })]);

    const { body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(syncSinceHistory).not.toHaveBeenCalled();
    expect(body).toMatchObject({ count: 0, succeeded: 0, failed: 0 });
  });

  it("answers GET with 405 rather than polling", async () => {
    const res = await handler(Route, "GET")({ request: cronRequest("gmail-poll"), params: {} });

    expect(res.status).toBe(405);
    expect(fake.calls.selects).toStrictEqual([]);
  });
});

describe("failure handling", () => {
  it("returns 500 with the message when the accounts query fails", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "connection reset by peer" }));

    const { status, body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(status).toBe(500);
    expect(body).toStrictEqual({ ok: false, error: "connection reset by peer" });
    expect(syncSinceHistory).not.toHaveBeenCalled();
  });

  it("counts a failing account without aborting the run, and logs its first error", async () => {
    fake.seed("gmail_accounts", [
      healthyAccount(),
      healthyAccount({
        id: "22222222-2222-4222-8222-222222222222",
        email_address: "b@example.com",
      }),
    ]);
    syncSinceHistory
      .mockRejectedValueOnce(new Error("Gmail 429 rate limited"))
      .mockResolvedValueOnce({ synced: 4 });

    const { status, body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, count: 2, succeeded: 1, failed: 1, synced: 4 });
    expect(writesTo(fake, "inserts", "pubsub_events")[0]?.payload).toMatchObject({
      event_type: "poll",
      error: "Gmail 429 rate limited",
    });
  });

  it("reports jobs as null when the queue drain throws, rather than failing the tick", async () => {
    fake.seed("gmail_accounts", [healthyAccount()]);
    runMessageJobs.mockRejectedValue(new Error("claim_message_jobs deadlock"));

    const { status, body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, jobs: null });
  });

  it("returns a JSON 500 rather than an unhandled rejection when the run crashes", async () => {
    fake.seed("gmail_accounts", [healthyAccount()]);
    // The pubsub_events write is inside its own try; the accounts read is not,
    // so make the *second* select the one that explodes.
    fake.onSelect("pubsub_events", () => {
      throw new Error("pubsub_events select exploded");
    });

    const { status, body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(status).toBe(500);
    expect(body).toStrictEqual({
      ok: false,
      error: "pubsub_events select exploded",
      run_id: RUN_ID,
    });
  });
});

describe("silence detection and watch re-arm", () => {
  const silent = () =>
    healthyAccount({
      last_push_at: new Date(NOW - 3 * HOUR).toISOString(),
      watch_expiration: new Date(NOW + 2 * 24 * HOUR).toISOString(),
    });

  it("re-arms a silent account and refreshes only its expiration", async () => {
    fake.seed("gmail_accounts", [silent()]);
    ensureWatch.mockResolvedValue({ historyId: "9001", expiration: String(NOW + 7 * 24 * HOUR) });

    const { body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(ensureWatch).toHaveBeenCalledWith(ACCOUNT_ID, null);
    expect(body.rearmed).toBe(1);
    const updates = writesTo(fake, "updates", "gmail_accounts");
    expect(updates.map((u) => u.payload)).toStrictEqual([
      { watch_expiration: new Date(NOW + 7 * 24 * HOUR).toISOString() },
      { history_id: "9001" },
    ]);
    // The cursor write is guarded by `history_id is null` so an existing
    // cursor is never jumped forward to Gmail's current head.
    expect(updates[1]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: ACCOUNT_ID, extra: undefined },
      { op: "is", col: "history_id", value: null, extra: undefined },
    ]);
    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toContainEqual({
      event_type: "watch_rearm_auto",
      email_address: "owner@example.com",
      history_id: "9001",
      details: "Per-account silence > 120min",
    });
  });

  it("leaves a recently-pushed account alone", async () => {
    fake.seed("gmail_accounts", [healthyAccount()]);

    const { body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(ensureWatch).not.toHaveBeenCalled();
    expect(body.rearmed).toBe(0);
  });

  it("treats a never-pushed account as silent only once it is older than the window", async () => {
    fake.seed("gmail_accounts", [
      healthyAccount({ last_push_at: null, created_at: new Date(NOW - 30 * 60_000).toISOString() }),
    ]);

    await callCron<PollBody>(Route, "gmail-poll");
    expect(ensureWatch).not.toHaveBeenCalled();

    fake.reset();
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    fake.seed("gmail_accounts", [
      healthyAccount({ last_push_at: null, created_at: new Date(NOW - 3 * HOUR).toISOString() }),
    ]);

    await callCron<PollBody>(Route, "gmail-poll");
    expect(ensureWatch).toHaveBeenCalledWith(ACCOUNT_ID, null);
  });

  it("does not re-arm when the watch has already lapsed (nothing to top up)", async () => {
    fake.seed("gmail_accounts", [
      healthyAccount({
        last_push_at: new Date(NOW - 3 * HOUR).toISOString(),
        watch_expiration: new Date(NOW - HOUR).toISOString(),
      }),
    ]);

    await callCron<PollBody>(Route, "gmail-poll");

    expect(ensureWatch).not.toHaveBeenCalled();
  });

  it("honours the 30-minute re-arm cooldown recorded in pubsub_events", async () => {
    fake.seed("gmail_accounts", [silent()]);
    fake.seedRaw("pubsub_events", [
      {
        event_type: "watch_rearm_auto",
        email_address: "owner@example.com",
        received_at: new Date(NOW - 10 * 60_000).toISOString(),
      },
    ]);

    const { body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(ensureWatch).not.toHaveBeenCalled();
    expect(body.rearmed).toBe(0);
  });

  it("re-arms again once the cooldown has expired", async () => {
    fake.seed("gmail_accounts", [silent()]);
    fake.seedRaw("pubsub_events", [
      {
        event_type: "watch_rearm_auto",
        email_address: "owner@example.com",
        received_at: new Date(NOW - 31 * 60_000).toISOString(),
      },
    ]);
    ensureWatch.mockResolvedValue({ historyId: "9001", expiration: String(NOW + 7 * 24 * HOUR) });

    const { body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(body.rearmed).toBe(1);
  });

  it("keeps syncing the account when the re-arm itself throws", async () => {
    fake.seed("gmail_accounts", [silent()]);
    ensureWatch.mockRejectedValue(new Error("watch topic misconfigured"));
    syncSinceHistory.mockResolvedValue({ synced: 1 });

    const { body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(body).toMatchObject({ rearmed: 0, succeeded: 1, failed: 0, synced: 1 });
  });

  it("counts no re-arm when ensureWatch declines (no Pub/Sub topic configured)", async () => {
    fake.seed("gmail_accounts", [silent()]);
    ensureWatch.mockResolvedValue(null);

    const { body } = await callCron<PollBody>(Route, "gmail-poll");

    expect(body.rearmed).toBe(0);
    expect(writesTo(fake, "updates", "gmail_accounts")).toStrictEqual([]);
  });
});
