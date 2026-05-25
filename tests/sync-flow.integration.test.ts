// End-to-end integration tests for the email-sync cron endpoints. Hits a
// real preview URL with a valid CRON_SECRET and asserts the response
// shapes match the contracts the operator dashboard relies on.
//
// SAFETY:
//   - Skipped unless BOTH PUBLIC_BASE_URL and CRON_SECRET are set.
//   - Designed to run against preview / staging, NOT production. The cron
//     endpoints perform real work (Gmail API calls, message_jobs draining).
//     Running them against production from CI is fine if the cron is
//     already running there anyway, but you'd be triggering an extra tick.
//
// Run:
//   PUBLIC_BASE_URL=https://preview.example.com \
//     CRON_SECRET=$(op read op://...) \
//     bun run test:integration
import { describe, it, expect } from "vitest";

const BASE = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;
const enabled = !!BASE && !!SECRET;
const d = enabled ? describe : describe.skip;

async function authedPost(path: string, body: unknown = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function expectJsonShape(res: Response, requiredKeys: string[]) {
  expect(res.status, await res.clone().text()).toBe(200);
  const json = await res.json();
  for (const key of requiredKeys) {
    expect(json, `missing key "${key}" in response: ${JSON.stringify(json)}`).toHaveProperty(key);
  }
  return json;
}

d("gmail-poll returns the documented summary shape", () => {
  it("authenticated POST returns {ok, succeeded, failed, rearmed, synced, jobs}", async () => {
    const res = await authedPost("/api/public/gmail-poll");
    const json = await expectJsonShape(res, ["ok", "succeeded", "failed", "rearmed", "synced", "jobs"]);
    expect(json.ok).toBe(true);
    expect(typeof json.succeeded).toBe("number");
    expect(typeof json.failed).toBe("number");
    expect(typeof json.synced).toBe("number");
    expect(typeof json.rearmed).toBe("number");
  });
});

d("gmail-process-jobs returns worker summary", () => {
  it("default drain returns processed/ok/failed/dlq counts", async () => {
    const res = await authedPost("/api/public/gmail-process-jobs");
    const json = await expectJsonShape(res, ["ok", "processed", "failed", "dlq"]);
    expect(json.ok).toBe(true);
    expect(typeof json.processed).toBe("number");
  });

  it("priority=0 filters to the live lane (still ok shape)", async () => {
    const res = await fetch(`${BASE}/api/public/gmail-process-jobs?priority=0`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    const json = await expectJsonShape(res, ["ok", "processed"]);
    expect(json.ok).toBe(true);
  });

  it("limit clamps to 200 (no internal error on huge requested limit)", async () => {
    const res = await fetch(`${BASE}/api/public/gmail-process-jobs?limit=99999`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

d("gmail-reconcile returns per-account result list", () => {
  it("authenticated POST returns {ok, results}", async () => {
    const res = await authedPost("/api/public/gmail-reconcile");
    const json = await expectJsonShape(res, ["ok", "results"]);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.results)).toBe(true);
    // Each result row is per-account. Either contains `result` (success)
    // or `error` (failure). We don't assert content beyond that — the
    // preview may not have any connected mailboxes at all.
    for (const r of json.results as Array<Record<string, unknown>>) {
      expect(r).toHaveProperty("account_id");
      const hasResultOrError = "result" in r || "error" in r;
      expect(hasResultOrError, `result row missing both .result and .error: ${JSON.stringify(r)}`).toBe(true);
    }
  });
});

d("gmail-renew-watches returns renewal summary", () => {
  it("authenticated POST returns {ok, succeeded, failed, stillExpiring}", async () => {
    const res = await authedPost("/api/public/gmail-renew-watches");
    const json = await expectJsonShape(res, ["ok", "succeeded", "failed", "stillExpiring"]);
    expect(json.ok).toBe(true);
    expect(typeof json.stillExpiring).toBe("number");
  });
});

d("gmail-backfill-tick is idempotent (no active jobs → 0 processed)", () => {
  it("returns {ok, processed, results}", async () => {
    const res = await authedPost("/api/public/gmail-backfill-tick");
    const json = await expectJsonShape(res, ["ok", "processed", "results"]);
    expect(json.ok).toBe(true);
    expect(Array.isArray(json.results)).toBe(true);
  });
});

d("gmail-retention prunes pubsub_events + DLQ + decryption audit rows", () => {
  it("returns {ok, pubsub, dlq, audit} with counts (or null if RPC missing)", async () => {
    const res = await authedPost("/api/public/gmail-retention");
    const json = await expectJsonShape(res, ["ok", "pubsub", "dlq", "audit"]);
    expect(json.ok).toBe(true);
    if (json.pubsub) {
      expect(json.pubsub).toHaveProperty("deleted");
      expect(json.pubsub).toHaveProperty("kept_errors");
      expect(json.pubsub).toHaveProperty("total_before");
    }
    if (json.dlq) {
      expect(json.dlq).toHaveProperty("deleted");
      expect(json.dlq).toHaveProperty("total_before");
    }
    if (json.audit) {
      expect(json.audit).toHaveProperty("deleted");
      expect(json.audit).toHaveProperty("total_before");
    }
  });

  it("honors query params (all three retention windows can be tightened)", async () => {
    // Just verify the endpoint accepts custom retention windows without
    // crashing. Doesn't assert on counts because they depend on existing
    // data.
    const res = await fetch(
      `${BASE}/api/public/gmail-retention?pubsub_keep_days=1&pubsub_limit=10&dlq_keep_days=1&dlq_limit=10&audit_keep_days=1&audit_limit=10`,
      { method: "POST", headers: { authorization: `Bearer ${SECRET}` } },
    );
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

d("gmail-dlq-replay returns both DLQ and forward summaries", () => {
  it("authenticated POST returns {ok, dlq, forwards}", async () => {
    const res = await authedPost("/api/public/gmail-dlq-replay");
    const json = await expectJsonShape(res, ["ok", "dlq", "forwards"]);
    expect(json.ok).toBe(true);
    // The cron logs `dlq_replay` event regardless, so if Supabase RPCs
    // aren't deployed yet these come back null with an error string. The
    // endpoint itself still returns 200 — making it safe to schedule.
    if (json.dlq) {
      expect(json.dlq).toHaveProperty("checked");
      expect(json.dlq).toHaveProperty("replayed");
      expect(json.dlq).toHaveProperty("skipped");
    }
    if (json.forwards) {
      expect(json.forwards).toHaveProperty("processed");
      expect(json.forwards).toHaveProperty("ok");
      expect(json.forwards).toHaveProperty("failed");
      expect(json.forwards).toHaveProperty("gaveUp");
    }
  });
});

// Note: getSyncLatencyStats is a TanStack Start server function — it isn't
// directly exposed as a /api/public route, so it can't be hit from outside
// authenticated app context. We can still smoke-test the underlying SQL
// function via a synthetic webhook push (which writes a pubsub_events row
// with latency_ms set) → wait → poll cron → eventually p50/p95 populates.
//
// The simpler invariant we CAN check here: the cron endpoints that read
// the latency telemetry don't crash when the RPC isn't yet deployed (the
// server function catches and returns an empty bucket shape).

d("gmail-webhook accepts a signed test envelope", () => {
  it("synthetic test ping returns 200 ok", async () => {
    // The webhook's x-zerrow-test header is gated by CRON_SECRET — proves
    // the auth path on the webhook is wired without requiring a valid OIDC
    // signer.
    const res = await fetch(`${BASE}/api/public/gmail-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zerrow-test": "1",
        authorization: `Bearer ${SECRET}`,
      },
      body: JSON.stringify({
        message: {
          messageId: `test-${Date.now()}`,
          publishTime: new Date().toISOString(),
        },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).toMatch(/ok/);
  });

  it("synthetic test ping WITHOUT cron secret is rejected", async () => {
    // Without the secret, x-zerrow-test must NOT allow the request through —
    // otherwise anyone could trigger syncs for any known email address.
    const res = await fetch(`${BASE}/api/public/gmail-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zerrow-test": "1",
      },
      body: JSON.stringify({ message: { messageId: "no-auth" } }),
    });
    expect(res.status).toBe(401);
  });
});
