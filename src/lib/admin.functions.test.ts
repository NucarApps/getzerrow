// src/lib/admin.functions.ts — the cross-tenant admin dashboard. Every fn here
// reads other users' data, so the only thing between a normal account and the
// whole estate is `assertAdmin` matching the JWT `email` claim against
// ADMIN_EMAILS. That gate gets the bulk of the coverage; the rest pins the
// paging, the label fallbacks and the percentile maths.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

import {
  getAdminMe,
  listAdminUsers,
  getAdminActivity,
  getFolderRetryMetrics,
  getSyncJobMetrics,
} from "./admin.functions";

const NOW = "2026-05-10T00:00:00.000Z";

/** Call a stubbed server fn with a request context. The real `createServerFn`
 *  signature has no `context` slot (middleware supplies it) — only the stub
 *  honors one, the same trick `impersonate` uses for `userId`. */
function withClaims<R>(
  fn: (...args: never[]) => Promise<R>,
  claims: unknown,
): (data?: unknown) => Promise<R> {
  const stubbed = fn as unknown as (a: {
    data?: unknown;
    context: Record<string, unknown>;
  }) => Promise<R>;
  return (data?: unknown) => stubbed({ data, context: { claims } });
}

const ADMIN_CLAIMS = { email: "boss@atzro.test", email_verified: true };

/** `assertAdmin` throws a bare 403 `Response`, not an `Error`. */
async function expectForbidden(call: () => Promise<unknown>) {
  const thrown = await call().then(
    () => null,
    (e: unknown) => e,
  );
  expect(thrown, "expected a rejection").not.toBeNull();
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(403);
}

beforeEach(() => {
  fake.reset();
  vi.stubEnv("ADMIN_EMAILS", "boss@atzro.test");
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

/* -------------------------------------------------------------------------- */
/* assertAdmin (through getAdminMe)                                            */
/* -------------------------------------------------------------------------- */

describe("assertAdmin", () => {
  it("matches the allowlist ignoring case and surrounding whitespace on both sides", async () => {
    vi.stubEnv("ADMIN_EMAILS", "  Boss@Atzro.test  , second@atzro.test ");

    // Both sides are trimmed and lowercased, for the match and for the
    // value handed back — which used to echo whatever padding the claim
    // carried.
    await expect(
      withClaims(getAdminMe, { email: " BOSS@atzro.TEST ", email_verified: true })(),
    ).resolves.toStrictEqual({ email: "boss@atzro.test" });
    await expect(
      withClaims(getAdminMe, { email: "second@atzro.test", email_verified: true })(),
    ).resolves.toStrictEqual({ email: "second@atzro.test" });
  });

  it("forbids an email that is not on the allowlist", async () => {
    await expectForbidden(withClaims(getAdminMe, { email: "nobody@atzro.test" }));
  });

  it("forbids everyone when ADMIN_EMAILS is unset or empty", async () => {
    vi.stubEnv("ADMIN_EMAILS", undefined);
    await expectForbidden(withClaims(getAdminMe, ADMIN_CLAIMS));

    vi.stubEnv("ADMIN_EMAILS", "");
    await expectForbidden(withClaims(getAdminMe, ADMIN_CLAIMS));

    // A list of nothing but separators/whitespace is also empty.
    vi.stubEnv("ADMIN_EMAILS", " , , ");
    await expectForbidden(withClaims(getAdminMe, ADMIN_CLAIMS));
  });

  it("forbids a non-string email claim and missing claims entirely", async () => {
    for (const claims of [
      { email: 42 },
      { email: null },
      { email: ["boss@atzro.test"] },
      { email: { toString: () => "boss@atzro.test" } },
      {},
      null,
      undefined,
    ]) {
      await expectForbidden(withClaims(getAdminMe, claims));
    }
  });

  it("refuses a claim whose email is unverified", async () => {
    // An allowlisted address is not an identity: anyone who can sign up
    // asserting it would otherwise get the cross-tenant dashboard.
    await expectForbidden(
      withClaims(getAdminMe, { email: "boss@atzro.test", email_verified: false }),
    );
  });

  it("refuses a claim with no email_verified at all, rather than assuming it", async () => {
    await expectForbidden(withClaims(getAdminMe, { email: "boss@atzro.test" }));
  });
});

/* -------------------------------------------------------------------------- */
/* listAdminUsers                                                              */
/* -------------------------------------------------------------------------- */

function seedAuthPage(users: Array<{ id: string; email?: string | null; created_at: string }>) {
  fake.onAuth("listUsers", () => ({
    data: {
      users: users.map((u) => ({
        id: u.id,
        email: u.email === undefined ? `${u.id}@acme.test` : u.email,
        created_at: u.created_at,
        last_sign_in_at: null,
      })),
    },
  }));
}

describe("listAdminUsers", () => {
  it("forbids a non-admin before reading any auth user", async () => {
    await expectForbidden(withClaims(listAdminUsers, { email: "nobody@atzro.test" }));
    expect(fake.calls.auth).toHaveLength(0);
  });

  it("joins the stats RPC and gmail accounts onto each user, newest first", async () => {
    seedAuthPage([
      { id: "u-old", created_at: "2026-01-01T00:00:00Z" },
      { id: "u-new", created_at: "2026-04-01T00:00:00Z" },
      { id: "u-noemail", email: null, created_at: "2026-02-01T00:00:00Z" },
    ]);
    fake.onRpc("admin_user_stats", () => ({
      data: [
        {
          user_id: "u-new",
          email_count: "12",
          folder_count: 3,
          contact_count: 4,
          jobs_pending: 1,
          jobs_running: 0,
          jobs_dlq: 2,
        },
      ],
    }));
    fake.seed("gmail_accounts", [
      {
        id: "g2",
        user_id: "u-new",
        email_address: "zeta@acme.test",
        last_poll_at: null,
        last_push_at: null,
        watch_expiration: null,
        history_id: null,
      },
      {
        id: "g1",
        user_id: "u-new",
        email_address: "alpha@acme.test",
        last_poll_at: "2026-04-02T00:00:00Z",
        last_push_at: null,
        watch_expiration: null,
        history_id: "7",
      },
    ]);

    const res = await withClaims(listAdminUsers, ADMIN_CLAIMS)();

    expect(res.users.map((u) => u.user_id)).toStrictEqual(["u-new", "u-noemail", "u-old"]);
    expect(res.users[0]).toStrictEqual({
      user_id: "u-new",
      email: "u-new@acme.test",
      created_at: "2026-04-01T00:00:00Z",
      last_sign_in_at: null,
      // Sorted by address, not by insertion order.
      gmail_accounts: [
        {
          email_address: "alpha@acme.test",
          last_poll_at: "2026-04-02T00:00:00Z",
          last_push_at: null,
          watch_expiration: null,
          has_history_id: true,
        },
        {
          email_address: "zeta@acme.test",
          last_poll_at: null,
          last_push_at: null,
          watch_expiration: null,
          has_history_id: false,
        },
      ],
      stats: {
        emails: 12,
        folders: 3,
        contacts: 4,
        jobs_pending: 1,
        jobs_running: 0,
        jobs_dlq: 2,
      },
    });
    // A user with no stats row and no mailbox still renders with zeros.
    expect(res.users[1]).toMatchObject({
      email: "(no email)",
      gmail_accounts: [],
      stats: { emails: 0, folders: 0, contacts: 0, jobs_pending: 0, jobs_running: 0, jobs_dlq: 0 },
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("stops paging as soon as a page comes back short of 200", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `u-${i}`,
      created_at: "2026-01-01T00:00:00Z",
    }));
    const page2 = [{ id: "u-last", created_at: "2026-01-02T00:00:00Z" }];
    let call = 0;
    fake.onAuth("listUsers", () => {
      call += 1;
      const users = call === 1 ? page1 : page2;
      return {
        data: {
          users: users.map((u) => ({ ...u, email: `${u.id}@acme.test`, last_sign_in_at: null })),
        },
      };
    });

    const res = await withClaims(listAdminUsers, ADMIN_CLAIMS)();

    expect(fake.calls.auth.map((a) => a.args)).toStrictEqual([
      { page: 1, perPage: 200 },
      { page: 2, perPage: 200 },
    ]);
    expect(res.users).toHaveLength(201);
  });

  it("stops at the 50-page safety cap when every page is full", async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `u-${i}`,
      email: `u-${i}@acme.test`,
      created_at: "2026-01-01T00:00:00Z",
      last_sign_in_at: null,
    }));
    fake.onAuth("listUsers", () => ({ data: { users: full } }));

    const res = await withClaims(listAdminUsers, ADMIN_CLAIMS)();

    expect(fake.calls.auth).toHaveLength(50);
    expect(res.users).toHaveLength(50 * 200);
  });

  it("propagates an auth paging failure", async () => {
    fake.onAuth("listUsers", () => ({ error: { message: "auth down" } }));
    await expect(withClaims(listAdminUsers, ADMIN_CLAIMS)()).rejects.toThrow("auth down");
  });

  it("propagates a stats RPC failure", async () => {
    seedAuthPage([{ id: "u1", created_at: "2026-01-01T00:00:00Z" }]);
    fake.onRpc("admin_user_stats", () => ({ error: { message: "stats blocked" } }));
    await expect(withClaims(listAdminUsers, ADMIN_CLAIMS)()).rejects.toThrow("stats blocked");
  });
});

/* -------------------------------------------------------------------------- */
/* getAdminActivity                                                            */
/* -------------------------------------------------------------------------- */

describe("getAdminActivity", () => {
  it("forbids a non-admin before calling the RPC", async () => {
    await expectForbidden(() => withClaims(getAdminActivity, { email: "x@y.test" })({}));
    expect(fake.calls.rpcs).toHaveLength(0);
  });

  it("defaults to a 30-day window and splits the series into signups and emails", async () => {
    fake.onRpc("admin_daily_activity", () => ({
      data: [
        { day: "2026-05-09", signups: "2", emails: 40 },
        { day: "2026-05-10", signups: 0, emails: "7" },
      ],
    }));

    const res = await withClaims(getAdminActivity, ADMIN_CLAIMS)({});

    expect(fake.calls.rpcs).toStrictEqual([{ fn: "admin_daily_activity", args: { p_days: 30 } }]);
    expect(res).toStrictEqual({
      days: 30,
      signups: [
        { date: "2026-05-09", count: 2 },
        { date: "2026-05-10", count: 0 },
      ],
      emails: [
        { date: "2026-05-09", count: 40 },
        { date: "2026-05-10", count: 7 },
      ],
    });
  });

  it("honours an explicit window and rejects one outside 7..180", async () => {
    await withClaims(getAdminActivity, ADMIN_CLAIMS)({ days: 7 });
    expect(fake.calls.rpcs[0]!.args).toStrictEqual({ p_days: 7 });

    await expect(withClaims(getAdminActivity, ADMIN_CLAIMS)({ days: 181 })).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* getFolderRetryMetrics                                                       */
/* -------------------------------------------------------------------------- */

describe("getFolderRetryMetrics", () => {
  it("forbids a non-admin before reading the retry log", async () => {
    await expectForbidden(() => withClaims(getFolderRetryMetrics, { email: "x@y.test" })({}));
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("labels a missing folder '(deleted folder)' and a null folder id '(no folder)'", async () => {
    fake.seed("folder_write_retries", [
      {
        id: "r1",
        folder_id: "f-live",
        occurred_at: "2026-05-09T10:00:00Z",
        attempts: 2,
        outcome: "retry",
      },
      {
        id: "r2",
        folder_id: "f-gone",
        occurred_at: "2026-05-09T11:00:00Z",
        attempts: 5,
        outcome: "failure",
      },
      {
        id: "r3",
        folder_id: null,
        occurred_at: "2026-05-10T00:00:00Z",
        attempts: 1,
        outcome: "retry",
      },
    ]);
    fake.seed("folders", [{ id: "f-live", user_id: "someone", name: "Invoices" }]);
    fake.seed("folder_retry_alerts", [
      { id: "a1", folder_id: "f-gone", retry_count: 9, fired_at: "2026-05-09T12:00:00Z" },
    ]);

    const res = await withClaims(getFolderRetryMetrics, ADMIN_CLAIMS)({ days: 2 });

    expect(res.days).toBe(2);
    expect(res.totals).toStrictEqual({ retries: 3, failed: 1, folders_affected: 3 });
    // Equal retry counts keep the read order, which is occurred_at descending.
    expect(res.byFolder.map((f) => [f.folder_id, f.name])).toStrictEqual([
      [null, "(no folder)"],
      ["f-gone", "(deleted folder)"],
      ["f-live", "Invoices"],
    ]);
    expect(res.recentAlerts).toStrictEqual([
      {
        folder_id: "f-gone",
        name: "(deleted folder)",
        retry_count: 9,
        fired_at: "2026-05-09T12:00:00Z",
      },
    ]);
  });

  it("fills every day in the window and buckets each retry into its day", async () => {
    fake.seed("folder_write_retries", [
      {
        id: "r1",
        folder_id: "f",
        occurred_at: "2026-05-10T05:00:00Z",
        attempts: 1,
        outcome: "failure",
      },
      {
        id: "r2",
        folder_id: "f",
        occurred_at: "2026-05-10T06:00:00Z",
        attempts: 3,
        outcome: "retry",
      },
    ]);

    const res = await withClaims(getFolderRetryMetrics, ADMIN_CLAIMS)({ days: 3 });

    expect(res.daily).toStrictEqual([
      { date: "2026-05-08", retries: 0, failed: 0 },
      { date: "2026-05-09", retries: 0, failed: 0 },
      { date: "2026-05-10", retries: 2, failed: 1 },
    ]);
    // One folder row, keeping the highest attempt count and the latest stamp.
    expect(res.byFolder).toStrictEqual([
      {
        folder_id: "f",
        name: "(deleted folder)",
        retries: 2,
        failed: 1,
        max_attempts: 3,
        last_at: "2026-05-10T06:00:00Z",
      },
    ]);
  });

  it("skips the folder-name lookup entirely when nothing retried", async () => {
    const res = await withClaims(getFolderRetryMetrics, ADMIN_CLAIMS)({});

    expect(res.days).toBe(7);
    expect(res.totals).toStrictEqual({ retries: 0, failed: 0, folders_affected: 0 });
    expect(res.daily).toHaveLength(7);
    expect(fake.calls.selects.map((s) => s.table)).toStrictEqual([
      "folder_write_retries",
      "folder_retry_alerts",
    ]);
  });

  it("propagates a retry-log read failure", async () => {
    fake.onSelect("folder_write_retries", () => ({ message: "log unreadable" }));
    await expect(withClaims(getFolderRetryMetrics, ADMIN_CLAIMS)({})).rejects.toThrow(
      "log unreadable",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* getSyncJobMetrics                                                           */
/* -------------------------------------------------------------------------- */

describe("getSyncJobMetrics", () => {
  it("forbids a non-admin before reading the queue", async () => {
    await expectForbidden(withClaims(getSyncJobMetrics, { email: "x@y.test" }));
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("returns null percentiles and zeroed counters on an empty queue", async () => {
    const res = await withClaims(getSyncJobMetrics, ADMIN_CLAIMS)();

    expect(res.counts).toStrictEqual({ pending: 0, running: 0, dlq: 0, total: 0 });
    expect(res.retries).toStrictEqual({ with_attempts: 0, max_attempt: 0, avg_attempt: 0 });
    expect(res.oldest_pending_at).toBeNull();
    expect(res.oldest_pending_age_seconds).toBeNull();
    expect(res.latency_ms).toStrictEqual({ count: 0, p50: null, p95: null, p99: null });
    expect(res.recent_dlq).toStrictEqual([]);
  });

  it("counts each queue state, the retry pressure and the oldest pending age", async () => {
    fake.seed("message_jobs", [
      {
        id: "j1",
        user_id: "u1",
        status: "pending",
        attempt: 0,
        next_run_at: "2026-05-09T23:00:00Z",
        gmail_message_id: "m1",
        gmail_account_id: "a1",
        updated_at: NOW,
      },
      {
        id: "j2",
        user_id: "u1",
        status: "pending",
        attempt: 3,
        next_run_at: "2026-05-09T22:00:00Z",
        gmail_message_id: "m2",
        gmail_account_id: "a1",
        updated_at: NOW,
      },
      {
        id: "j3",
        user_id: "u1",
        status: "running",
        attempt: 1,
        next_run_at: NOW,
        gmail_message_id: "m3",
        gmail_account_id: "a1",
        updated_at: NOW,
      },
      {
        id: "j4",
        user_id: "u1",
        status: "dlq",
        attempt: 9,
        next_run_at: NOW,
        gmail_message_id: "m4",
        gmail_account_id: "a1",
        last_error: "boom",
        updated_at: "2026-05-09T20:00:00Z",
      },
    ]);

    const res = await withClaims(getSyncJobMetrics, ADMIN_CLAIMS)();

    expect(res.counts).toStrictEqual({ pending: 2, running: 1, dlq: 1, total: 4 });
    // The DLQ job is excluded from retry pressure; attempts 3 and 1 remain.
    expect(res.retries).toStrictEqual({ with_attempts: 2, max_attempt: 3, avg_attempt: 2 });
    expect(res.oldest_pending_at).toBe("2026-05-09T22:00:00Z");
    expect(res.oldest_pending_age_seconds).toBe(7200);
    expect(res.recent_dlq).toStrictEqual([
      {
        id: "j4",
        gmail_message_id: "m4",
        attempt: 9,
        last_error: "boom",
        updated_at: "2026-05-09T20:00:00Z",
      },
    ]);
  });

  it("drops out-of-range latencies and indexes p50/p95/p99 off the sorted list", async () => {
    const created = "2026-05-09T12:00:00.000Z";
    const createdMs = Date.parse(created);
    const row = (id: string, latency: number) => ({
      id,
      user_id: "u1",
      created_at: created,
      published_at_ms: createdMs - latency,
    });

    fake.seed("emails", [
      row("e1", 0),
      row("e2", 100),
      row("e3", 200),
      row("e4", 300),
      row("e5", 400),
      // Negative latency (published after the row appeared) — dropped.
      row("e6", -50),
      // An hour or more — dropped.
      row("e7", 3_600_000),
      // Zero / non-numeric published stamps — dropped.
      { id: "e8", user_id: "u1", created_at: created, published_at_ms: 0 },
    ]);

    const res = await withClaims(getSyncJobMetrics, ADMIN_CLAIMS)();

    expect(res.latency_ms).toStrictEqual({ count: 5, p50: 200, p95: 300, p99: 300 });
    // Throughput counts every row in the window, latency-eligible or not.
    expect(res.throughput_last_24h).toBe(8);
  });

  it("propagates a queue read failure", async () => {
    fake.onSelect("message_jobs", () => ({ message: "queue unreadable" }));
    await expect(withClaims(getSyncJobMetrics, ADMIN_CLAIMS)()).rejects.toThrow("queue unreadable");
  });
});
