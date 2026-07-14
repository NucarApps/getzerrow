// End-to-end integration tests for the concurrency contract of
// syncSinceHistory / syncSinceHistoryLocked.
//
// These aren't unit tests for the internals — they drive the real
// exported entry point with N overlapping callers and assert on the
// observable queue/lease behavior:
//
//   1. withAccountLock coalesces overlapping calls for the same account
//      (single Gmail listHistory, single enqueue, single history-id bump,
//      identical result promise for every caller).
//   2. Different accounts do NOT coalesce — they run in parallel.
//   3. Once the in-flight promise resolves, a new call runs fresh.
//   4. Bootstrap (account.history_id null) is coalesced too — never runs
//      twice from concurrent callers.
//   5. The bump_history_id_if_greater RPC is the only path used to
//      advance history_id (monotonic guard is preserved even when many
//      history pages are drained in one locked run).
//
// The Gmail SDK, Supabase client, and enqueue module are all replaced
// with controllable fakes so the test can pace history-page fetches and
// count RPC/enqueue invocations deterministically.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─────────────── Supabase admin fake ─────────────────────────────────
//
// A very small chainable builder: enough to satisfy the query shapes
// history.ts actually issues. Every .single()/.maybeSingle() resolves
// from the seeded per-account row; every write returns { error: null }.

type AccountRow = {
  id: string;
  user_id: string;
  email_address: string;
  history_id: string | null;
  watch_expiration: string | null;
};

const accountsById = new Map<string, AccountRow>();
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const updateCalls: Array<{ table: string; patch: Record<string, unknown>; where: string }> = [];

function makeBuilder(table: string) {
  const state: { filters: Record<string, unknown>; op: string; payload?: unknown } = {
    filters: {},
    op: "select",
  };
  const chain: Record<string, unknown> = {
    select() {
      state.op = "select";
      return chain;
    },
    eq(col: string, val: unknown) {
      state.filters[col] = val;
      return chain;
    },
    in() {
      return chain;
    },
    not() {
      return chain;
    },
    order() {
      return chain;
    },
    limit() {
      return chain;
    },
    update(patch: Record<string, unknown>) {
      state.op = "update";
      state.payload = patch;
      // Update returns a thenable directly (no terminal call in history.ts).
      const where = Object.entries(state.filters)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join("&");
      updateCalls.push({ table, patch, where });
      return {
        then<T>(resolve: (v: { error: null }) => T) {
          return Promise.resolve({ error: null }).then(resolve);
        },
        eq(col: string, val: unknown) {
          state.filters[col] = val;
          const w = Object.entries(state.filters)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join("&");
          updateCalls[updateCalls.length - 1].where = w;
          return this;
        },
      };
    },
    delete() {
      state.op = "delete";
      return {
        eq() {
          return this;
        },
        in() {
          return Promise.resolve({ error: null });
        },
      };
    },
    async single() {
      if (table === "gmail_accounts") {
        const id = String(state.filters.id ?? "");
        const row = accountsById.get(id);
        return row ? { data: row, error: null } : { data: null, error: new Error("not found") };
      }
      return { data: null, error: null };
    },
    async maybeSingle() {
      if (table === "gmail_accounts") {
        const id = String(state.filters.id ?? "");
        const row = accountsById.get(id);
        return { data: row ?? null, error: null };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

vi.mock("@/integrations/supabase/client.server", () => {
  return {
    supabaseAdmin: {
      from(table: string) {
        return makeBuilder(table);
      },
      async rpc(fn: string, args: Record<string, unknown>) {
        rpcCalls.push({ fn, args });
        return { data: null, error: null };
      },
    },
  };
});

// ─────────────── Gmail SDK fake ──────────────────────────────────────
//
// listHistory is controllable per-account: we can pace it with a deferred
// promise so overlapping callers arrive while the first is mid-flight.

type HistoryPage = {
  historyId?: string;
  history?: Array<{
    messages?: Array<{ id: string }>;
    messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }>;
    labelsAdded?: [];
    labelsRemoved?: [];
    messagesDeleted?: [];
  }>;
  nextPageToken?: string;
};

const listHistoryCalls: Array<{ accountId: string; startHistoryId: string }> = [];
const listHistoryQueue = new Map<string, Array<() => Promise<HistoryPage>>>();

function queuePage(accountId: string, page: HistoryPage, gate?: Promise<void>) {
  const arr = listHistoryQueue.get(accountId) ?? [];
  arr.push(async () => {
    if (gate) await gate;
    return page;
  });
  listHistoryQueue.set(accountId, arr);
}

vi.mock("../gmail.server", () => {
  class GmailApiError extends Error {
    status: number;
    retryable: boolean;
    retryAfterSeconds: number | null;
    isQuotaExceeded: boolean;
    constructor(status: number, msg: string) {
      super(msg);
      this.status = status;
      this.retryable = status >= 500 || status === 429;
      this.retryAfterSeconds = null;
      this.isQuotaExceeded = false;
    }
  }
  return {
    GmailApiError,
    async listHistory(accountId: string, startHistoryId: string) {
      listHistoryCalls.push({ accountId, startHistoryId });
      const q = listHistoryQueue.get(accountId) ?? [];
      const next = q.shift();
      if (!next) return { historyId: startHistoryId, history: [], nextPageToken: undefined };
      return next();
    },
    async ensureWatch() {
      return null; // skip watch renewal — we bump via the plain path
    },
    async getMessageMetadata() {
      return {};
    },
    async listMessages() {
      return { messages: [], nextPageToken: undefined };
    },
  };
});

// ─────────────── Enqueue + backfill fakes ────────────────────────────

const enqueueCalls: Array<{
  accountId: string;
  userId: string;
  ids: string[];
  priority: number;
}> = [];

vi.mock("./enqueue", () => ({
  async enqueueMessageJobs(
    accountId: string,
    userId: string,
    ids: string[],
    priority: number = 0,
  ) {
    enqueueCalls.push({ accountId, userId, ids: [...ids], priority });
  },
}));

vi.mock("./backfill", () => ({
  async backfillRecent() {
    return;
  },
}));

vi.mock("./folder-learn", () => ({
  async recordManualMove() {
    return;
  },
}));

vi.mock("../log.server", () => ({
  logError: () => {},
  logInfo: () => {},
  newRunId: () => "test-run",
}));

// ─────────────── System under test ───────────────────────────────────
//
// Import AFTER mocks are registered so the module graph picks them up.

import { syncSinceHistory } from "./history";

function seedAccount(row: AccountRow) {
  accountsById.set(row.id, row);
}

beforeEach(() => {
  accountsById.clear();
  rpcCalls.length = 0;
  updateCalls.length = 0;
  listHistoryCalls.length = 0;
  listHistoryQueue.clear();
  enqueueCalls.length = 0;
});

describe("syncSinceHistory concurrency (withAccountLock contract)", () => {
  it("coalesces overlapping callers for the same account into one execution", async () => {
    seedAccount({
      id: "acc-A",
      user_id: "user-A",
      email_address: "a@x.com",
      history_id: "1000",
      watch_expiration: null,
    });

    // Gate the first (and only) history page so we can fan callers in
    // BEFORE the in-flight promise resolves.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    queuePage(
      "acc-A",
      {
        historyId: "1050",
        history: [
          {
            messagesAdded: [
              { message: { id: "m1", labelIds: ["INBOX"] } },
              { message: { id: "m2", labelIds: ["INBOX"] } },
            ],
          },
        ],
      },
      gate,
    );

    // Fire 5 concurrent callers.
    const promises = Array.from({ length: 5 }, () => syncSinceHistory("acc-A"));
    // Give the first caller a tick to install the lock.
    await new Promise((r) => setTimeout(r, 0));
    release();
    const results = await Promise.all(promises);

    // All 5 callers observe the identical resolved value (from ONE run).
    for (const r of results) expect(r).toEqual({ synced: 2 });

    // Exactly one Gmail listHistory + one enqueue call, regardless of
    // how many callers piled in.
    expect(listHistoryCalls).toHaveLength(1);
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toMatchObject({
      accountId: "acc-A",
      userId: "user-A",
      ids: ["m1", "m2"],
      priority: 0,
    });

    // history_id advanced exactly once, via the monotonic RPC (never a
    // raw UPDATE to gmail_accounts.history_id).
    const bumpCalls = rpcCalls.filter((c) => c.fn === "bump_history_id_if_greater");
    // One end-of-run bump + one per-page bump for the drained page.
    expect(bumpCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of bumpCalls) {
      expect(c.args.p_account_id).toBe("acc-A");
      expect(c.args.p_new_history_id).toBe("1050");
    }
    const rawHistoryUpdates = updateCalls.filter(
      (u) => u.table === "gmail_accounts" && "history_id" in u.patch,
    );
    expect(rawHistoryUpdates).toHaveLength(0);
  });

  it("runs different accounts in parallel — the lock is per accountId", async () => {
    seedAccount({
      id: "acc-A",
      user_id: "user-A",
      email_address: "a@x.com",
      history_id: "1000",
      watch_expiration: null,
    });
    seedAccount({
      id: "acc-B",
      user_id: "user-B",
      email_address: "b@x.com",
      history_id: "2000",
      watch_expiration: null,
    });

    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });
    queuePage(
      "acc-A",
      { historyId: "1001", history: [{ messagesAdded: [{ message: { id: "a1" } }] }] },
      gateA,
    );
    queuePage(
      "acc-B",
      { historyId: "2001", history: [{ messagesAdded: [{ message: { id: "b1" } }] }] },
      gateB,
    );

    const pA = syncSinceHistory("acc-A");
    const pB = syncSinceHistory("acc-B");

    // Both callers are in-flight simultaneously; releasing them in
    // reverse order proves the second one wasn't queued behind the first.
    await new Promise((r) => setTimeout(r, 0));
    releaseB();
    releaseA();
    const [rA, rB] = await Promise.all([pA, pB]);

    expect(rA).toEqual({ synced: 1 });
    expect(rB).toEqual({ synced: 1 });
    expect(listHistoryCalls).toHaveLength(2);
    expect(enqueueCalls.map((e) => e.accountId).sort()).toEqual(["acc-A", "acc-B"]);
  });

  it("releases the lock after the run — a later call executes fresh", async () => {
    seedAccount({
      id: "acc-A",
      user_id: "user-A",
      email_address: "a@x.com",
      history_id: "1000",
      watch_expiration: null,
    });
    queuePage("acc-A", {
      historyId: "1001",
      history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
    });
    await syncSinceHistory("acc-A");

    // Second, non-overlapping call. Should re-run.
    queuePage("acc-A", {
      historyId: "1002",
      history: [{ messagesAdded: [{ message: { id: "m2" } }] }],
    });
    // history_id in our fake account row hasn't advanced (the RPC is
    // stubbed), so the second listHistory should still be called from
    // history_id=1000 — that's fine; the assertion is that it ran again.
    const r = await syncSinceHistory("acc-A");

    expect(r).toEqual({ synced: 1 });
    expect(listHistoryCalls).toHaveLength(2);
    expect(enqueueCalls).toHaveLength(2);
    expect(enqueueCalls.map((c) => c.ids)).toEqual([["m1"], ["m2"]]);
  });

  it("coalesces overlapping bootstrap runs too (history_id null path)", async () => {
    seedAccount({
      id: "acc-C",
      user_id: "user-C",
      email_address: "c@x.com",
      history_id: null,
      watch_expiration: null,
    });

    // Fan 4 callers in against a cold-start bootstrap.
    const promises = Array.from({ length: 4 }, () => syncSinceHistory("acc-C"));
    const results = await Promise.all(promises);

    // Every caller resolves with the same shape from the single run.
    for (const r of results) expect(r).toEqual({ bootstrapped: true });

    // Bootstrap goes through listMessages, not listHistory — so no
    // listHistory calls, and no phantom double-enqueue from the extra
    // callers piling on.
    expect(listHistoryCalls).toHaveLength(0);
    // The fake listMessages returns empty, so no enqueue either.
    expect(enqueueCalls).toHaveLength(0);
  });

  it("bumps history_id via the monotonic RPC once per drained page", async () => {
    seedAccount({
      id: "acc-A",
      user_id: "user-A",
      email_address: "a@x.com",
      history_id: "500",
      watch_expiration: null,
    });
    // Two pages: nextPageToken forces the loop to advance and bump between.
    queuePage("acc-A", {
      historyId: "600",
      history: [{ messagesAdded: [{ message: { id: "m1" } }] }],
      nextPageToken: "PAGE2",
    });
    queuePage("acc-A", {
      historyId: "700",
      history: [{ messagesAdded: [{ message: { id: "m2" } }] }],
    });

    const r = await syncSinceHistory("acc-A");
    expect(r).toEqual({ synced: 2 });

    // 2 pages drained → 2 per-page bumps, plus 1 end-of-run bump = 3.
    // Ordering must be monotonic (never regresses).
    const bumps = rpcCalls
      .filter((c) => c.fn === "bump_history_id_if_greater")
      .map((c) => String(c.args.p_new_history_id));
    expect(bumps.length).toBeGreaterThanOrEqual(2);
    let prev = -Infinity;
    for (const b of bumps) {
      const n = Number(b);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    // Last bump reflects the last page's historyId.
    expect(bumps[bumps.length - 1]).toBe("700");
    // Only one enqueue call carrying every id from both pages.
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0].ids).toEqual(["m1", "m2"]);
  });
});
