// Contract for the Gmail Pub/Sub push endpoint — the busiest entry point in
// the system, and the only one whose *response status* is load-bearing:
// Pub/Sub redelivers anything that is not 2xx, so a handler that 500s on a
// downstream failure turns one bad message into a redelivery loop.
//
// cron-auth.test.ts pins the refusals (no token / wrong token / cron bearer).
// This file pins everything past the gate: which envelopes are accepted, what
// is decoded out of them, which account they are matched to, what is written
// to pubsub_events in each case, and that the answer is always 200.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { handler } from "./__fixtures__/route-harness";
import { Route } from "./gmail-webhook";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const syncSinceHistory = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync.server").syncSinceHistory>(),
);
const runMessageJobs = vi.hoisted(() => vi.fn<typeof import("@/lib/sync.server").runMessageJobs>());
vi.mock("@/lib/sync.server", () => ({
  syncSinceHistory,
  runMessageJobs,
}));

const topUpWatch = vi.hoisted(() => vi.fn<typeof import("@/lib/gmail.server").topUpWatch>());
vi.mock("@/lib/gmail.server", () => ({ topUpWatch }));

const verifyGoogleJwt = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/google-jwt.server").verifyGoogleJwt>(),
);
vi.mock("@/lib/google-jwt.server", () => ({ verifyGoogleJwt }));

const POST = handler(Route, "POST");

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_TOKEN = "legacy-webhook-token";

/** A Pub/Sub push envelope carrying a base64 Gmail notification. */
function envelope(notification: unknown, over: Record<string, unknown> = {}) {
  return {
    subscription: "projects/atzro/subscriptions/gmail-push",
    message: {
      data: Buffer.from(JSON.stringify(notification)).toString("base64"),
      messageId: "pubsub-msg-1",
      publishTime: new Date(NOW - 250).toISOString(),
      ...over,
    },
  };
}

async function post(
  body: unknown,
  opts: { query?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const request = new Request(
    `https://atzro.test/api/public/gmail-webhook${opts.query ?? `?token=${LEGACY_TOKEN}`}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
  return POST({ request, params: {} });
}

/** The single summary row the handler writes in its `finally` block. */
function summaryRow(): Record<string, unknown> {
  const rows = writesTo(fake, "inserts", "pubsub_events").map(
    (w) => w.payload as Record<string, unknown>,
  );
  const summaries = rows.filter((r) =>
    ["push", "push_empty", "webhook_test"].includes(String(r.event_type)),
  );
  expect(summaries, "expected exactly one summary row per request").toHaveLength(1);
  return summaries[0]!;
}

function seedLiveAccount(over: Partial<Record<string, unknown>> = {}) {
  fake.seed("gmail_accounts", [
    {
      id: ACCOUNT_ID,
      email_address: "Owner@Example.com",
      watch_expiration: new Date(NOW + 10 * 86_400_000).toISOString(),
      needs_reconnect: false,
      ...over,
    },
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake.reset();
  vi.stubEnv("GMAIL_WEBHOOK_TOKEN", LEGACY_TOKEN);
  vi.stubEnv("GMAIL_WEBHOOK_LEGACY_DISABLED", undefined);
  vi.stubEnv("GMAIL_PUBSUB_SERVICE_ACCOUNT", undefined);
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  syncSinceHistory.mockResolvedValue({ synced: 0 });
  runMessageJobs.mockResolvedValue({ processed: 0 } as Awaited<ReturnType<typeof runMessageJobs>>);
  topUpWatch.mockResolvedValue(null);
});

describe("authentication", () => {
  it("accepts a Google-signed OIDC bearer and records no legacy-auth row", async () => {
    vi.stubEnv("GMAIL_PUBSUB_SERVICE_ACCOUNT", "pubsub@atzro.iam.gserviceaccount.com");
    verifyGoogleJwt.mockResolvedValue({
      ok: true,
      claims: { email: "pubsub@atzro.iam.gserviceaccount.com" },
    });

    const res = await post(envelope({ emailAddress: "owner@example.com", historyId: 42 }), {
      query: "",
      headers: { authorization: "Bearer signed.jwt.value" },
    });

    expect(res.status).toBe(200);
    expect(verifyGoogleJwt).toHaveBeenCalledWith("signed.jwt.value", {
      audiences: [
        "https://atzro.test/api/public/gmail-webhook",
        "https://atzro.test/api/public/gmail-webhook",
      ],
      expectedEmail: "pubsub@atzro.iam.gserviceaccount.com",
    });
    expect(
      writesTo(fake, "inserts", "pubsub_events").map(
        (w) => (w.payload as { event_type: string }).event_type,
      ),
    ).toStrictEqual(["push"]);
  });

  it("fails closed with an audit row when the signer email is not pinned", async () => {
    const res = await post(envelope({ emailAddress: "owner@example.com" }), {
      query: "",
      headers: { authorization: "Bearer signed.jwt.value" },
    });

    expect(res.status).toBe(401);
    expect(verifyGoogleJwt).not.toHaveBeenCalled();
    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toStrictEqual([
      {
        event_type: "push_unauthorized",
        subscription: "/api/public/gmail-webhook",
        details:
          "OIDC bearer rejected: GMAIL_PUBSUB_SERVICE_ACCOUNT is not configured, so the signer's identity cannot be pinned",
      },
    ]);
  });

  it("records the verifier's reason when an OIDC bearer fails verification", async () => {
    vi.stubEnv("GMAIL_PUBSUB_SERVICE_ACCOUNT", "pubsub@atzro.iam.gserviceaccount.com");
    verifyGoogleJwt.mockResolvedValue({ ok: false, reason: "expired" });

    const res = await post(envelope({ emailAddress: "owner@example.com" }), {
      query: "",
      headers: { authorization: "Bearer signed.jwt.value" },
    });

    expect(res.status).toBe(401);
    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toStrictEqual([
      {
        event_type: "push_unauthorized",
        subscription: "/api/public/gmail-webhook",
        details: "OIDC verify failed: expired",
      },
    ]);
    expect(syncSinceHistory).not.toHaveBeenCalled();
  });

  it("accepts the legacy ?token= secret and logs it for migration tracking", async () => {
    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(res.status).toBe(200);
    const inserts = writesTo(fake, "inserts", "pubsub_events");
    expect(inserts[0]?.payload).toStrictEqual({
      event_type: "push_legacy_auth",
      // The token itself must never be persisted — only a fingerprint.
      subscription: "/api/public/gmail-webhook?token=<redacted:le…en (len 20)>",
      details: "Authenticated via legacy ?token= — migrate subscription to OIDC",
    });
  });

  it("refuses the legacy token once GMAIL_WEBHOOK_LEGACY_DISABLED is set", async () => {
    vi.stubEnv("GMAIL_WEBHOOK_LEGACY_DISABLED", "1");

    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(res.status).toBe(401);
    expect(writesTo(fake, "inserts", "pubsub_events")[0]?.payload).toMatchObject({
      event_type: "push_unauthorized",
      details:
        "Legacy ?token= auth is disabled (GMAIL_WEBHOOK_LEGACY_DISABLED=1) — subscription must present an OIDC bearer",
    });
  });

  it("reports a token mismatch as fingerprints, never as the secrets themselves", async () => {
    const res = await post(envelope({ emailAddress: "owner@example.com" }), {
      query: "?token=wrong-token-value",
    });

    expect(res.status).toBe(401);
    const details = String(
      (writesTo(fake, "inserts", "pubsub_events")[0]?.payload as { details: string }).details,
    );
    expect(details).toBe("Token mismatch (provided wr…ue (len 17), expected le…en (len 20))");
    expect(details).not.toContain(LEGACY_TOKEN);
  });

  it("requires the cron secret before honouring the x-atzro-test bypass", async () => {
    const res = await post(envelope({ emailAddress: "owner@example.com" }), {
      query: "",
      headers: { "x-atzro-test": "1" },
    });

    // No cron credentials → the bypass does not apply and the request falls
    // through to normal push auth, which has neither a bearer nor a ?token=.
    expect(res.status).toBe(401);
    expect(syncSinceHistory).not.toHaveBeenCalled();
  });

  it("tags an authenticated synthetic test as webhook_test, not a real push", async () => {
    seedLiveAccount();
    const res = await post(envelope({ emailAddress: "owner@example.com", historyId: 7 }), {
      query: "",
      headers: { "x-atzro-test": "1", authorization: "Bearer test-cron-secret" },
    });

    expect(res.status).toBe(200);
    expect(summaryRow()).toMatchObject({
      event_type: "webhook_test",
      details: "App-side webhook test — matched account and ran sync",
    });
  });
});

describe("envelope decoding", () => {
  it("decodes message.data into emailAddress + historyId and matches the account", async () => {
    seedLiveAccount();

    const res = await post(envelope({ emailAddress: "owner@example.com", historyId: 987 }));

    expect(res.status).toBe(200);
    expect(syncSinceHistory).toHaveBeenCalledWith(ACCOUNT_ID, { publishedAtMs: NOW - 250 });
    expect(summaryRow()).toStrictEqual({
      event_type: "push",
      email_address: "owner@example.com",
      history_id: "987",
      accounts_matched: 1,
      synced_count: 0,
      error: null,
      message_id: "pubsub-msg-1",
      publish_time: new Date(NOW - 250).toISOString(),
      subscription: "projects/atzro/subscriptions/gmail-push",
      payload: { emailAddress: "owner@example.com", historyId: 987 },
      latency_ms: 250,
      details: null,
    });
  });

  it("matches the stored address case-insensitively (Gmail lowercases the push)", async () => {
    seedLiveAccount({ email_address: "Owner@Example.com" });

    await post(envelope({ emailAddress: "owner@example.com" }));

    expect(syncSinceHistory).toHaveBeenCalledWith(ACCOUNT_ID, { publishedAtMs: NOW - 250 });
    expect(summaryRow()).toMatchObject({ accounts_matched: 1 });
  });

  it("carries a string historyId through unchanged", async () => {
    seedLiveAccount();

    await post(envelope({ emailAddress: "owner@example.com", historyId: "9007199254740993" }));

    expect(summaryRow()).toMatchObject({ history_id: "9007199254740993" });
  });

  it("acks an envelope with no message.data as push_empty rather than retrying it", async () => {
    const res = await post({ subscription: "projects/atzro/subscriptions/gmail-push" });

    expect(res.status).toBe(200);
    expect(summaryRow()).toStrictEqual({
      event_type: "push_empty",
      email_address: null,
      history_id: null,
      // Null rather than 0: "we never looked" is not the same as "no match".
      accounts_matched: null,
      synced_count: null,
      error: null,
      message_id: null,
      publish_time: null,
      subscription: "projects/atzro/subscriptions/gmail-push",
      payload: { subscription: "projects/atzro/subscriptions/gmail-push" },
      latency_ms: null,
      details: "Pub/Sub envelope had no message.data field",
    });
    expect(syncSinceHistory).not.toHaveBeenCalled();
  });

  it("acks a body that is not JSON at all instead of 500ing into a redelivery loop", async () => {
    const res = await post("not json");

    expect(res.status).toBe(200);
    const row = summaryRow();
    expect(row.event_type).toBe("push_empty");
    expect(row.error).toEqual(expect.any(String));
  });

  it("acks an envelope whose message.data is not base64 JSON, keeping the raw payload", async () => {
    const res = await post({ message: { data: "!!!not-base64!!!", messageId: "m-9" } });

    expect(res.status).toBe(200);
    const row = summaryRow();
    expect(row.event_type).toBe("push");
    expect(row.payload).toStrictEqual({ raw: "!!!not-base64!!!" });
    expect(String(row.details)).toContain("Failed to decode message.data");
    expect(syncSinceHistory).not.toHaveBeenCalled();
  });

  it("accepts the snake_case envelope variant Pub/Sub also emits", async () => {
    seedLiveAccount();

    await post({
      message: {
        data: Buffer.from(JSON.stringify({ emailAddress: "owner@example.com" })).toString("base64"),
        message_id: "snake-1",
        publish_time: new Date(NOW - 1000).toISOString(),
      },
    });

    expect(summaryRow()).toMatchObject({
      message_id: "snake-1",
      publish_time: new Date(NOW - 1000).toISOString(),
      latency_ms: 1000,
    });
  });

  it("records a decoded payload with no emailAddress and does no account work", async () => {
    const res = await post(envelope({ historyId: 5 }));

    expect(res.status).toBe(200);
    expect(summaryRow()).toMatchObject({
      email_address: null,
      accounts_matched: 0,
      details: "Decoded payload had no emailAddress field",
    });
    expect(fake.calls.selects.filter((s) => s.table === "gmail_accounts")).toStrictEqual([]);
  });
});

describe("account matching", () => {
  it("acks and explains an address that matches no connected account", async () => {
    const res = await post(envelope({ emailAddress: "stranger@example.com" }));

    expect(res.status).toBe(200);
    expect(summaryRow()).toMatchObject({
      email_address: "stranger@example.com",
      accounts_matched: 0,
      details:
        'No gmail_accounts row matches "stranger@example.com" — watch was probably created against a different connected account.',
    });
    expect(syncSinceHistory).not.toHaveBeenCalled();
  });

  it("skips a dead-OAuth account and says so instead of reporting no match", async () => {
    seedLiveAccount({ needs_reconnect: true });

    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(res.status).toBe(200);
    expect(summaryRow()).toMatchObject({
      accounts_matched: 0,
      details: 'Account(s) for "owner@example.com" need reconnect — skipped.',
    });
    expect(syncSinceHistory).not.toHaveBeenCalled();
  });

  it("syncs every live account sharing the pushed address", async () => {
    fake.seed("gmail_accounts", [
      { id: ACCOUNT_ID, email_address: "owner@example.com", needs_reconnect: false },
      {
        id: "22222222-2222-4222-8222-222222222222",
        email_address: "OWNER@example.com",
        needs_reconnect: false,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        email_address: "owner@example.com",
        needs_reconnect: true,
      },
    ]);
    syncSinceHistory.mockResolvedValue({ synced: 2 });
    // Two live accounts × 2 synced each; the drain below is exercised in its
    // own test, so keep the queue empty here.
    runMessageJobs.mockResolvedValue({ processed: 0 } as Awaited<
      ReturnType<typeof runMessageJobs>
    >);
    vi.useRealTimers();

    await post(envelope({ emailAddress: "owner@example.com" }));

    expect(syncSinceHistory.mock.calls.map((c) => c[0])).toStrictEqual([
      ACCOUNT_ID,
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(summaryRow()).toMatchObject({ accounts_matched: 2, synced_count: 4 });
  });
});

describe("resilience: a well-formed push is always acked", () => {
  it("returns 200 and records the message when the account sync throws", async () => {
    seedLiveAccount();
    syncSinceHistory.mockRejectedValue(new Error("Gmail 503 backend error"));

    const res = await post(envelope({ emailAddress: "owner@example.com", historyId: 3 }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(summaryRow()).toMatchObject({
      event_type: "push",
      accounts_matched: 1,
      synced_count: 0,
      error: "Gmail 503 backend error",
    });
  });

  it("returns 200 even when writing the summary row itself fails", async () => {
    seedLiveAccount();
    fake.onInsert("pubsub_events", () => {
      throw new Error("pubsub_events insert exploded");
    });

    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("keeps syncing when the opportunistic watch top-up throws", async () => {
    seedLiveAccount();
    topUpWatch.mockRejectedValue(new Error("watch quota exceeded"));

    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(res.status).toBe(200);
    // A failed top-up is non-fatal: the sync still counted, and no error is
    // attributed to the push itself (the renewal cron retries).
    expect(summaryRow()).toMatchObject({ accounts_matched: 1, error: null });
  });
});

describe("opportunistic watch top-up", () => {
  it("refreshes only the expiration, never the history cursor", async () => {
    seedLiveAccount();
    topUpWatch.mockResolvedValue({ historyId: "555", expiration: String(NOW + 7 * 86_400_000) });

    await post(envelope({ emailAddress: "owner@example.com" }));

    expect(topUpWatch).toHaveBeenCalledWith(
      ACCOUNT_ID,
      new Date(NOW + 10 * 86_400_000).toISOString(),
    );
    const updates = writesTo(fake, "updates", "gmail_accounts");
    expect(updates.map((u) => u.payload)).toStrictEqual([
      { watch_expiration: new Date(NOW + 7 * 86_400_000).toISOString() },
    ]);
    expect(updates[0]?.filters).toStrictEqual([
      { op: "eq", col: "id", value: ACCOUNT_ID, extra: undefined },
    ]);
    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toContainEqual({
      event_type: "watch_renew",
      email_address: "Owner@Example.com",
      history_id: "555",
      details: "Opportunistic top-up from push webhook",
    });
  });
});

describe("duplicate delivery", () => {
  it("acks a redelivery of the same messageId within 60s without re-syncing", async () => {
    seedLiveAccount();
    fake.seedRaw("pubsub_events", [
      {
        id: "prior-row-id",
        message_id: "pubsub-msg-1",
        event_type: "push",
        received_at: new Date(NOW - 30_000).toISOString(),
      },
    ]);

    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok (duplicate)");
    expect(syncSinceHistory).not.toHaveBeenCalled();
    expect(writesTo(fake, "inserts", "pubsub_events").map((w) => w.payload)).toContainEqual({
      event_type: "push_duplicate",
      message_id: "pubsub-msg-1",
      details: "Duplicate Pub/Sub delivery within 60s (original prior-row-id)",
    });
  });

  // CHARACTERIZATION(webhook-duplicate-logs-spurious-push-empty): the early
  // return for a duplicate delivery runs the finally block, which writes a
  // second summary row — flip when fixed
  it("also writes an empty push summary row for the duplicate (spurious)", async () => {
    seedLiveAccount();
    fake.seedRaw("pubsub_events", [
      {
        id: "prior-row-id",
        message_id: "pubsub-msg-1",
        event_type: "push",
        received_at: new Date(NOW - 30_000).toISOString(),
      },
    ]);

    await post(envelope({ emailAddress: "owner@example.com" }));

    expect(summaryRow()).toStrictEqual({
      event_type: "push_empty",
      email_address: null,
      history_id: null,
      accounts_matched: null,
      synced_count: null,
      error: null,
      message_id: "pubsub-msg-1",
      publish_time: null,
      subscription: null,
      payload: null,
      latency_ms: null,
      details: null,
    });
  });

  it("processes a redelivery once the 60s dedupe window has passed", async () => {
    seedLiveAccount();
    fake.seedRaw("pubsub_events", [
      {
        id: "prior-row-id",
        message_id: "pubsub-msg-1",
        event_type: "push",
        received_at: new Date(NOW - 61_000).toISOString(),
      },
    ]);

    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(await res.text()).toBe("ok");
    expect(syncSinceHistory).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe synthetic test pushes against real ones", async () => {
    seedLiveAccount();
    fake.seedRaw("pubsub_events", [
      {
        id: "prior-row-id",
        message_id: "pubsub-msg-1",
        event_type: "push",
        received_at: new Date(NOW - 1_000).toISOString(),
      },
    ]);

    const res = await post(envelope({ emailAddress: "owner@example.com" }), {
      query: "",
      headers: { "x-atzro-test": "1", authorization: "Bearer test-cron-secret" },
    });

    expect(await res.text()).toBe("ok");
    expect(summaryRow()).toMatchObject({ event_type: "webhook_test" });
  });
});

describe("inline queue drain", () => {
  it("drains the priority-0 queue only when the sync actually enqueued work", async () => {
    // Real timers: drainWithBudget is a wall-clock budget loop with a 300ms
    // backoff between empty rounds, which a frozen clock would spin forever.
    vi.useRealTimers();
    seedLiveAccount();
    syncSinceHistory.mockResolvedValue({ synced: 3 });

    await post(envelope({ emailAddress: "owner@example.com" }, { publishTime: undefined }));

    expect(runMessageJobs).toHaveBeenCalledWith(50, expect.any(Number), {
      priority: 0,
      deferAiToCron: true,
    });
  });

  it("skips the drain entirely when nothing was enqueued", async () => {
    seedLiveAccount();
    syncSinceHistory.mockResolvedValue({ synced: 0 });

    await post(envelope({ emailAddress: "owner@example.com" }));

    expect(runMessageJobs).not.toHaveBeenCalled();
  });

  it("still acks when the inline drain throws", async () => {
    vi.useRealTimers();
    seedLiveAccount();
    syncSinceHistory.mockResolvedValue({ synced: 1 });
    runMessageJobs.mockRejectedValue(new Error("claim_message_jobs deadlock"));

    const res = await post(envelope({ emailAddress: "owner@example.com" }));

    expect(res.status).toBe(200);
    expect(summaryRow()).toMatchObject({ synced_count: 1, error: null });
  });
});
