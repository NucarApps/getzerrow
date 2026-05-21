// Live integration tests against the deployed public endpoints. These verify
// that cron and webhook endpoints reject requests without the correct secrets.
//
// These tests hit a real URL and are skipped unless PUBLIC_BASE_URL is set.
// Run against the preview (latest build):
//   PUBLIC_BASE_URL=https://project--9ca78824-55f5-4897-b74d-b5b1d219918a-dev.lovable.app bun run test:integration
// Run against production after publishing:
//   PUBLIC_BASE_URL=https://getzerrow.lovable.app bun run test:integration
import { describe, it, expect } from "vitest";

const BASE = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const runIf = BASE ? describe : describe.skip;


const CRON_ENDPOINTS = [
  "/api/public/gmail-poll",
  "/api/public/gmail-process-jobs",
  "/api/public/gmail-renew-watches",
  "/api/public/hooks/run-folder-summaries",
];

async function post(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("cron endpoints reject unauthenticated calls", () => {
  for (const path of CRON_ENDPOINTS) {
    it(`${path} returns 401 with no Authorization header`, async () => {
      const res = await post(path, { body: "{}" });
      expect(res.status, await res.text()).toBe(401);
    });

    it(`${path} returns 401 with a wrong Bearer token`, async () => {
      const res = await post(path, {
        body: "{}",
        headers: { authorization: "Bearer obviously-wrong-secret" },
      });
      expect(res.status, await res.text()).toBe(401);
    });

    it(`${path} returns 401 with a wrong x-cron-secret header`, async () => {
      const res = await post(path, {
        body: "{}",
        headers: { "x-cron-secret": "obviously-wrong-secret" },
      });
      expect(res.status, await res.text()).toBe(401);
    });
  }
});

describe("gmail-webhook rejects unauthenticated calls", () => {
  const path = "/api/public/gmail-webhook";

  it("returns 401 when ?token=... is missing", async () => {
    const res = await post(path, { body: JSON.stringify({ message: {} }) });
    expect(res.status, await res.text()).toBe(401);
  });

  it("returns 401 when ?token=... is wrong", async () => {
    const res = await post(`${path}?token=obviously-wrong-token`, {
      body: JSON.stringify({ message: {} }),
    });
    expect(res.status, await res.text()).toBe(401);
  });

  it("does NOT accept the cron Bearer token in place of the webhook token", async () => {
    // The webhook is gated by GMAIL_WEBHOOK_TOKEN (query string), not CRON_SECRET.
    const res = await post(path, {
      body: JSON.stringify({ message: {} }),
      headers: { authorization: "Bearer anything" },
    });
    expect(res.status, await res.text()).toBe(401);
  });
});
