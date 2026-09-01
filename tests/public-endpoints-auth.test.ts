// Live post-deploy smoke: the deployed public endpoints reject requests
// without the correct secrets.
//
// The CI gate for cron auth is the IN-PROCESS suite at
// src/routes/api/public/cron-auth.test.ts, which runs on every PR with no
// deployed URL. This file is the optional live-HTTP complement — run it
// against a real deployment after publishing:
//   PUBLIC_BASE_URL=https://getzerrow.lovable.app bun run test:integration
//
// Skipped entirely (like the other integration suites) unless
// PUBLIC_BASE_URL is set, so a bare `bun run test:integration` no longer
// fires ~80 fetches at "undefined/api/public/...".
//
// The endpoint list is DERIVED from src/routes/api/public/ at run time so
// it can never drift out of sync with the routes dir again (the old
// hand-maintained list needed a "task 13 audit" to catch back up). Routes
// with their own auth scheme are excluded below, each with the reason.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const BASE = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const enabled = !!BASE;
const d = enabled ? describe : describe.skip;

// Routes under /api/public that are NOT gated by the shared cron secret.
// Every entry must name its own auth story; anything not listed here is
// expected to 401 on the cron sweep below.
const NON_CRON_ROUTES = new Set([
  "gmail-webhook", // GMAIL_WEBHOOK_TOKEN query param — covered by its own describe below
  "google-oauth-callback", // OAuth state round-trip, browser-facing
  "logo", // public logo proxy with its own guards
  "meeting-recording", // signed per-meeting stream token (verifyRecordingStreamToken)
  "recall-realtime", // x-recall-token constant-time compare
  "recall-webhook", // Svix signature (RECALL_WEBHOOK_SECRET)
  "carddav", // CardDAV's own auth (carddav/auth.server.ts)
  "og", // public OG images
]);

/** Every /api/public route path, derived from the routes dir. */
function cronEndpoints(): string[] {
  const root = join(process.cwd(), "src/routes/api/public");
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    // Test files live beside the routes (cron-auth.test.ts) but are kept
    // out of the deployed route tree by routeFileIgnorePattern — sweeping
    // them would 404, not 401.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    const rel = join(entry.parentPath ?? "", entry.name)
      .slice(root.length + 1)
      .replace(/\.tsx?$/, "");
    const top = (rel.split("/")[0] ?? "").replace(/\.\$.*$/, "").replace(/\$$/, "");
    if (NON_CRON_ROUTES.has(top) || NON_CRON_ROUTES.has(rel)) continue;
    out.push(`/api/public/${rel}`);
  }
  return out.sort();
}

async function post(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

d("cron endpoints reject unauthenticated calls", () => {
  it("enumeration sanity: the sweep found the routes dir", () => {
    // Guards against a silent empty sweep (e.g. Dirent.parentPath absent
    // on an old Node, or the dir moving) — mirrors cron-auth.test.ts.
    const endpoints = cronEndpoints();
    expect(endpoints).toContain("/api/public/gmail-poll");
    expect(endpoints.length).toBeGreaterThanOrEqual(20);
  });

  for (const path of cronEndpoints()) {
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

d("gmail-webhook rejects unauthenticated calls", () => {
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
