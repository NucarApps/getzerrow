// Sender-origin backfill (origin-backfill.functions.ts). A resumable,
// budgeted, concurrent batch job that repairs three columns on old rows.
// Every one of those adjectives is a contract a refactor can break while
// still looking like it works:
//
//   * NARROWNESS. The job must write only reply_to_addr / origin_addr /
//     is_forwarded. It never reclassifies, moves mail, or touches
//     encrypted fields — a widened UPDATE payload here would silently
//     rewrite a user's whole mailbox, so the payload keys are pinned
//     exactly,
//   * RESUMABILITY. `next_before` is the received_at of the OLDEST row
//     actually looked at, and is null only when the run is genuinely done.
//     Returning the wrong one either repeats a page forever or skips one,
//   * BUDGET. Work stops at the wall-clock budget and reports done:false,
//     so the caller keeps paging instead of believing the mailbox is
//     clean,
//   * ISOLATION. Both the scan and each UPDATE filter on user_id — this
//     runs on the admin client, which bypasses RLS,
//   * RESILIENCE. One unreadable message is logged and skipped, never
//     aborting the batch; the row keeps its null origin so the next run
//     retries it,
//   * a message Gmail reports as having no forwarding signal at all is not
//     written back, since an UPDATE of three nulls is pure write
//     amplification across a whole mailbox.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

type Parsed = {
  reply_to_addr: string | null;
  origin_addr: string | null;
  is_forwarded: boolean;
};
const getMessage = vi.fn(async (_accountId: string, _messageId: string) => ({ id: _messageId }));
const parseMessage = vi.fn((_msg: unknown): Parsed => ({
  reply_to_addr: "reply@example.com",
  origin_addr: "origin@example.com",
  is_forwarded: true,
}));
vi.mock("../gmail.server", () => ({
  getMessage: (...a: unknown[]) => getMessage(...(a as [string, string])),
  parseMessage: (...a: unknown[]) => parseMessage(...(a as [unknown])),
}));

const logError = vi.fn();
vi.mock("../log.server", () => ({ logError: (...a: unknown[]) => logError(...(a as [])) }));

const { backfillOriginSenders, getOriginBackfillStatus } =
  await import("./origin-backfill.functions");

import type { OriginBackfillResult } from "./origin-backfill.functions";

const run = (data: unknown = {}) =>
  impersonate(backfillOriginSenders, TEST_USER)({ data }) as Promise<OriginBackfillResult>;

/** Fixed "now" the seeded timestamps hang off, so the 90-day window is stable. */
const RUN_AT = Date.now();

/** Timestamp of the i-th newest seeded row: today minus i days. */
const receivedAt = (i: number) => new Date(RUN_AT - i * 86_400_000).toISOString();

/** `count` rows, newest first, all owned by the caller and all missing an origin. */
function seedPending(count: number, opts: { user?: string } = {}) {
  fake.seedRaw(
    "emails",
    Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      user_id: opts.user ?? TEST_USER,
      gmail_message_id: `m${i}`,
      gmail_account_id: "acct-1",
      // Descending from today so the rows sit inside the default 90-day
      // window and the fake's order() gives a stable newest-first page.
      received_at: receivedAt(i),
      from_addr: "sender@example.com",
      origin_addr: null,
    })),
  );
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
  getMessage.mockImplementation(async (_a, id) => ({ id }));
  parseMessage.mockReturnValue({
    reply_to_addr: "reply@example.com",
    origin_addr: "origin@example.com",
    is_forwarded: true,
  });
});

describe("backfillOriginSenders scan", () => {
  it("reports done immediately when nothing is pending", async () => {
    const res = await run();
    expect(res).toEqual({ scanned: 0, updated: 0, next_before: null, done: true });
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("scans only the caller's rows that still lack an origin, newest first", async () => {
    seedPending(2);
    await run();
    expect(fake.calls.selects[0]).toMatchObject({
      table: "emails",
      filters: [
        { op: "eq", col: "user_id", value: TEST_USER },
        { op: "is", col: "origin_addr", value: null },
        { op: "gte", col: "received_at", value: expect.any(String) },
      ],
      limit: 150,
    });
  });

  it("pages backwards from the caller's cursor", async () => {
    seedPending(1);
    const cursor = receivedAt(3);
    await run({ before: cursor });
    expect(fake.calls.selects[0]?.filters).toContainEqual({
      op: "lt",
      col: "received_at",
      value: cursor,
      extra: undefined,
    });
  });

  it("ignores another user's pending rows", async () => {
    seedPending(3, { user: "someone-else" });
    expect(await run()).toMatchObject({ scanned: 0, done: true });
  });

  it("throws when the scan fails rather than reporting a clean mailbox", async () => {
    fake.onSelect("emails", () => ({ message: "scan failed" }));
    await expect(run()).rejects.toThrow("scan failed");
  });
});

describe("backfillOriginSenders writes", () => {
  it("writes only the three origin columns, scoped to the row and the caller", async () => {
    seedPending(1);
    await run();

    expect(fake.calls.updates).toHaveLength(1);
    // Exact payload, not a subset: a widened UPDATE here rewrites mail.
    expect(fake.calls.updates[0]?.payload).toEqual({
      reply_to_addr: "reply@example.com",
      origin_addr: "origin@example.com",
      is_forwarded: true,
    });
    expect(fake.calls.updates[0]?.filters).toEqual([
      { op: "eq", col: "id", value: "e0", extra: undefined },
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("counts a scanned row without writing when the message has no forwarding signal", async () => {
    seedPending(2);
    parseMessage.mockReturnValue({
      reply_to_addr: null,
      origin_addr: null,
      is_forwarded: false,
    });
    const res = await run();
    expect(res).toMatchObject({ scanned: 2, updated: 0 });
    expect(fake.calls.updates).toEqual([]);
  });

  it("writes a row that carries only a reply-to", async () => {
    seedPending(1);
    parseMessage.mockReturnValue({
      reply_to_addr: "reply@example.com",
      origin_addr: null,
      is_forwarded: false,
    });
    await run();
    expect(fake.calls.updates).toHaveLength(1);
  });

  it("fetches each row from its own Gmail account", async () => {
    seedPending(1);
    await run();
    expect(getMessage).toHaveBeenCalledWith("acct-1", "m0");
  });
});

describe("backfillOriginSenders resilience", () => {
  it("logs and skips a message it cannot read, finishing the rest", async () => {
    seedPending(3);
    getMessage.mockImplementation(async (_a, id) => {
      if (id === "m1") throw new Error("gmail 404");
      return { id };
    });

    const res = await run();

    expect(res).toMatchObject({ scanned: 3, updated: 2 });
    expect(logError).toHaveBeenCalledWith(
      "gmail.origin_backfill.row_failed",
      { email_id: "e1" },
      expect.any(Error),
    );
  });

  it("logs and skips a row whose update fails, without counting it as updated", async () => {
    seedPending(2);
    fake.onUpdate("emails", (_p, filters) =>
      filters.some((f) => f.value === "e1") ? { message: "update failed" } : null,
    );

    const res = await run();

    expect(res).toMatchObject({ scanned: 2, updated: 1 });
    expect(logError).toHaveBeenCalledWith(
      "gmail.origin_backfill.row_failed",
      { email_id: "e1" },
      expect.any(Error),
    );
  });
});

describe("backfillOriginSenders paging", () => {
  it("clears the cursor and reports done when the page was not full", async () => {
    seedPending(2);
    const res = await run({ limit: 10 });
    expect(res).toMatchObject({ done: true, next_before: null, scanned: 2 });
  });

  it("hands back the oldest scanned row's timestamp when the page was full", async () => {
    seedPending(10);
    const res = await run({ limit: 10 });
    // Rows run newest→oldest, so the last one scanned is the oldest.
    expect(res.done).toBe(false);
    expect(res.next_before).toBe(receivedAt(9));
  });

  it("stops at the wall-clock budget and keeps the caller paging", async () => {
    seedPending(20);
    // Each Gmail fetch burns 10s of the 18s budget.
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    getMessage.mockImplementation(async (_a, id) => {
      now += 10_000;
      return { id };
    });

    const res = await run({ limit: 300 });

    expect(res.done).toBe(false);
    expect(res.next_before).not.toBeNull();
    // Far short of the 20 seeded rows — the budget cut it off.
    expect(res.scanned).toBeLessThan(20);
  });
});

describe("backfillOriginSenders input contract", () => {
  it("rejects a non-ISO cursor and out-of-range days/limit", async () => {
    await expect(run({ before: "yesterday" })).rejects.toThrow();
    await expect(run({ days: 0 })).rejects.toThrow();
    await expect(run({ days: 366 })).rejects.toThrow();
    await expect(run({ limit: 9 })).rejects.toThrow();
    await expect(run({ limit: 301 })).rejects.toThrow();
  });

  it("defaults to 90 days and 150 rows", async () => {
    seedPending(1);
    await run();
    expect(fake.calls.selects[0]?.limit).toBe(150);
    const since = fake.calls.selects[0]?.filters.find((f) => f.op === "gte")?.value as string;
    const days = (Date.now() - Date.parse(since)) / 86_400_000;
    expect(days).toBeCloseTo(90, 1);
  });
});

describe("getOriginBackfillStatus", () => {
  it("counts pending and already-identified forwarded mail for the caller", async () => {
    fake.seedRaw("emails", [
      {
        id: "a",
        user_id: TEST_USER,
        origin_addr: null,
        is_forwarded: false,
        received_at: new Date().toISOString(),
      },
      {
        id: "b",
        user_id: TEST_USER,
        origin_addr: "x@y.z",
        is_forwarded: true,
        received_at: new Date().toISOString(),
      },
      {
        id: "c",
        user_id: "someone-else",
        origin_addr: null,
        is_forwarded: true,
        received_at: new Date().toISOString(),
      },
    ]);

    const res = await impersonate(getOriginBackfillStatus, TEST_USER)();

    expect(res).toEqual({ pending: 1, forwarded: 1 });
    expect(fake.calls.selects.every((s) => s.filters.some((f) => f.col === "user_id"))).toBe(true);
  });

  it("reports zeroes rather than nulls for an empty mailbox", async () => {
    expect(await impersonate(getOriginBackfillStatus, TEST_USER)()).toEqual({
      pending: 0,
      forwarded: 0,
    });
  });
});
