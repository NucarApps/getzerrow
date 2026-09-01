// In-process auth sweep for every /api/public/* server route. Replaces the
// live-HTTP integration sweep in tests/public-endpoints-auth.test.ts whose
// hand-maintained CRON_ENDPOINTS list drifted from the routes directory.
//
// Self-maintaining by construction: the route files are enumerated from this
// directory with readdirSync, so a newly added route is automatically swept.
// Every route that is not explicitly allowlisted below must reject a request
// carrying (a) no credentials, (b) a wrong Bearer token, and (c) a wrong
// x-cron-secret header with 401 — and must do so BEFORE any work happens
// (asserted as zero recorded Supabase calls on the shared fake).
//
// The Supabase admin client is mocked with the shared chainable fake so route
// modules import cleanly in the node test env and so the unauthorized path's
// only DB touch (the cron_secret_matches RPC fallback) is observable.
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Every route file under src/routes/api/public/, as posix-relative paths
 * (e.g. "hooks/send-digest.ts"), excluding test files like this one. */
const ALL_ROUTE_FILES = (readdirSync(ROUTES_DIR, { recursive: true }) as string[])
  .map((p) => p.split(path.sep).join("/"))
  .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
  .sort();

// Routes that are legitimately public or authenticate themselves by a
// mechanism other than the shared cron secret. Each entry says WHY it is
// exempt from the cron sweep; a stale entry fails the hygiene test below.
const PUBLIC_OR_SELF_AUTHENTICATING = new Set<string>([
  // Own auth: HTTP Basic with a hashed per-device app password, checked in
  // verifyCardDavAuth (src/lib/carddav/auth.server.ts) before any handler runs.
  "carddav/$.ts",
  // Own auth: Google-signed OIDC bearer JWT (signer pinned via
  // GMAIL_PUBSUB_SERVICE_ACCOUNT, fail-closed) or the legacy ?token= shared
  // secret (GMAIL_WEBHOOK_TOKEN) — NOT the cron secret. Covered by the
  // dedicated describe block at the bottom of this file.
  "gmail-webhook.ts",
  // OAuth redirect target hit by Google, so it cannot carry our secret;
  // authenticated by the signed, expiring `state` parameter (verifyState).
  "google-oauth-callback.ts",
  // Intentionally public logo proxy: read-only, no user data, input hardened
  // via isValidDomainShape/isBlockedDomain and a snapped size bucket.
  "logo.ts",
  // Own auth: short-lived HMAC stream token minted by the authenticated
  // getRecordingStreamUrl and checked by verifyRecordingStreamToken.
  "meeting-recording.ts",
  // Intentionally public OG preview image for shared contact-card pages;
  // serves only fields the public card page itself displays.
  "og/card.$handle.tsx",
  // Own auth: RECALL_REALTIME_TOKEN via x-recall-token header or legacy ?t=,
  // compared in constant time; fails closed when the env var is unset.
  "recall-realtime.ts",
  // Own auth: Svix HMAC signature verified against RECALL_WEBHOOK_SECRET;
  // fails closed when the secret is unset.
  "recall-webhook.ts",
]);

// Route files that cannot be dynamically imported in the node test env
// (import-time side effects). MUST stay exact: an entry that imports fine
// fails the "still cannot be imported" test (remove it), and a new route that
// fails to import fails its own sweep test loudly (fix the import or list it
// here with a comment saying why). Nothing is ever skipped silently.
const CANNOT_IMPORT = new Set<string>([]);

/** The routes the cron-auth sweep applies to. */
const CRON_ROUTES = ALL_ROUTE_FILES.filter(
  (rel) => !PUBLIC_OR_SELF_AUTHENTICATING.has(rel) && !CANNOT_IMPORT.has(rel),
);

type ServerHandler = (ctx: {
  request: Request;
  params: Record<string, string>;
}) => Response | Promise<Response>;

async function loadHandlers(rel: string): Promise<Record<string, ServerHandler>> {
  const mod = (await import(/* @vite-ignore */ path.join(ROUTES_DIR, rel))) as {
    Route?: { options?: { server?: { handlers?: Record<string, ServerHandler> } } };
  };
  const handlers = mod.Route?.options?.server?.handlers;
  expect(
    handlers,
    `${rel} does not export a Route with server.handlers — if it is not a server route, ` +
      `move it out of src/routes/api/public/ or allowlist it with a reason`,
  ).toBeTruthy();
  return handlers!;
}

function makeRequest(rel: string, method: string, headers: Record<string, string>): Request {
  const routePath = `/api/public/${rel.replace(/\.tsx?$/, "").replace(/\$$/, "sub/path")}`;
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`https://example.test${routePath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(hasBody ? { body: "{}" } : {}),
  });
}

/** Invoke every handler the route defines with the given headers and assert
 * each one refuses: 401 for POST (the cron method), 401 or 405 (method stub)
 * for anything else — and that no Supabase work was recorded. The only DB
 * touch tolerated is the cron_secret_matches RPC fallback inside
 * isAuthorizedCronRequest, and only when credentials were actually presented. */
async function expectAllHandlersReject(rel: string, headers: Record<string, string>) {
  const handlers = await loadHandlers(rel);
  expect(
    handlers.POST,
    `${rel} defines no POST handler — cron endpoints are POST; ` +
      `if this route is intentionally different, allowlist it with a reason`,
  ).toBeTypeOf("function");

  fake.reset();
  const presentedCredentials = "authorization" in headers || "x-cron-secret" in headers;

  for (const [method, handler] of Object.entries(handlers)) {
    const res = await handler({ request: makeRequest(rel, method, headers), params: {} });
    if (method === "POST") {
      expect(res.status, `${rel} POST must 401 an unauthorized request`).toBe(401);
    } else {
      // Non-POST handlers on cron routes are "Use POST" stubs (405). A future
      // handler that does real work must still authenticate (401).
      expect(
        [401, 405],
        `${rel} ${method} returned ${res.status} for an unauthorized request`,
      ).toContain(res.status);
    }
  }

  // The handler body must not have run: no table reads or writes at all.
  expect(fake.calls.selects, `${rel} read from the DB before auth passed`).toEqual([]);
  expect(fake.calls.inserts, `${rel} wrote to the DB before auth passed`).toEqual([]);
  expect(fake.calls.updates, `${rel} wrote to the DB before auth passed`).toEqual([]);
  expect(fake.calls.upserts, `${rel} wrote to the DB before auth passed`).toEqual([]);
  expect(fake.calls.deletes, `${rel} wrote to the DB before auth passed`).toEqual([]);
  const unexpectedRpcs = fake.calls.rpcs.filter((r) => r.fn !== "cron_secret_matches");
  expect(unexpectedRpcs, `${rel} called RPCs before auth passed`).toEqual([]);
  if (!presentedCredentials) {
    // With no credentials at all, auth must fail fast without even the
    // database secret fallback.
    expect(fake.calls.rpcs, `${rel} hit the DB for a credential-less request`).toEqual([]);
  }
}

describe("allowlist hygiene", () => {
  it("found the route files (enumeration sanity check)", () => {
    expect(ALL_ROUTE_FILES).toContain("gmail-poll.ts");
    expect(CRON_ROUTES.length).toBeGreaterThanOrEqual(20);
  });

  it("every allowlisted route corresponds to an existing file", () => {
    const stale = [...PUBLIC_OR_SELF_AUTHENTICATING].filter((f) => !ALL_ROUTE_FILES.includes(f));
    expect(stale, "stale PUBLIC_OR_SELF_AUTHENTICATING entries — remove them").toEqual([]);
  });

  it("every cannot-import entry corresponds to an existing, non-allowlisted file", () => {
    const stale = [...CANNOT_IMPORT].filter(
      (f) => !ALL_ROUTE_FILES.includes(f) || PUBLIC_OR_SELF_AUTHENTICATING.has(f),
    );
    expect(stale, "stale CANNOT_IMPORT entries — remove them").toEqual([]);
  });

  for (const rel of CANNOT_IMPORT) {
    it(`${rel} still cannot be imported (otherwise remove it from CANNOT_IMPORT)`, async () => {
      await expect(import(/* @vite-ignore */ path.join(ROUTES_DIR, rel))).rejects.toThrow();
    });
  }
});

describe("cron endpoints reject unauthenticated calls before doing any work", () => {
  for (const rel of CRON_ROUTES) {
    describe(`/api/public/${rel.replace(/\.tsx?$/, "")}`, () => {
      it("returns 401 with no credentials", async () => {
        vi.stubEnv("CRON_SECRET", "test-cron-secret");
        await expectAllHandlersReject(rel, {});
      });

      it("returns 401 with a wrong Bearer token", async () => {
        vi.stubEnv("CRON_SECRET", "test-cron-secret");
        await expectAllHandlersReject(rel, { authorization: "Bearer obviously-wrong-secret" });
      });

      it("returns 401 with a wrong x-cron-secret header", async () => {
        vi.stubEnv("CRON_SECRET", "test-cron-secret");
        await expectAllHandlersReject(rel, { "x-cron-secret": "obviously-wrong-secret" });
      });
    });
  }
});

// gmail-webhook authenticates itself (OIDC JWT or ?token= shared secret) and
// is therefore allowlisted from the cron sweep — but its own gate still gets
// pinned here, mirroring the live-HTTP test this file replaces. Unauthorized
// attempts ARE allowed to write their push_unauthorized audit rows to
// pubsub_events; anything beyond that means the handler body ran.
describe("gmail-webhook rejects unauthenticated calls", () => {
  const rel = "gmail-webhook.ts";

  async function postWebhook(headers: Record<string, string>, query = "") {
    const handlers = await loadHandlers(rel);
    fake.reset();
    const request = new Request(`https://example.test/api/public/gmail-webhook${query}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ message: {} }),
    });
    const postHandler = handlers.POST;
    if (!postHandler) throw new Error(`${rel} exports no POST handler`);
    return postHandler({ request, params: {} });
  }

  function expectNoGmailWorkRan() {
    expect(fake.calls.selects, "webhook read the DB before auth passed").toEqual([]);
    expect(fake.calls.updates).toEqual([]);
    expect(fake.calls.upserts).toEqual([]);
    expect(fake.calls.deletes).toEqual([]);
    expect(fake.calls.rpcs).toEqual([]);
    const nonAuditInserts = fake.calls.inserts.filter((w) => w.table !== "pubsub_events");
    expect(nonAuditInserts, "webhook wrote non-audit rows before auth passed").toEqual([]);
  }

  it("returns 401 when the ?token= is missing", async () => {
    vi.stubEnv("GMAIL_WEBHOOK_TOKEN", "right-webhook-token");
    const res = await postWebhook({});
    expect(res.status).toBe(401);
    expectNoGmailWorkRan();
  });

  it("returns 401 when the ?token= is wrong", async () => {
    vi.stubEnv("GMAIL_WEBHOOK_TOKEN", "right-webhook-token");
    const res = await postWebhook({}, "?token=obviously-wrong-token");
    expect(res.status).toBe(401);
    expectNoGmailWorkRan();
  });

  it("does NOT accept the cron Bearer token in place of the webhook auth", async () => {
    // A Bearer token routes to OIDC verification, which fails closed when
    // GMAIL_PUBSUB_SERVICE_ACCOUNT is unset — the cron secret must never pass.
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    vi.stubEnv("GMAIL_WEBHOOK_TOKEN", "right-webhook-token");
    const res = await postWebhook({ authorization: "Bearer test-cron-secret" });
    expect(res.status).toBe(401);
    expectNoGmailWorkRan();
  });
});
