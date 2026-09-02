// In-process auth sweep for every /api/mobile/* route, mirroring the one
// over /api/public in src/routes/api/public/cron-auth.test.ts.
//
// These routes serve the iOS companion app and read decrypted mail,
// contacts and meetings for whoever calls them, so the guard that matters
// is that authenticateRequest runs BEFORE any handler work. That is
// asserted two ways: the response is 401, and the shared Supabase fake
// recorded no reads or writes.
//
// Self-maintaining: the route files are enumerated from this directory, so
// a new mobile route is swept the moment it lands.
import { readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

// The user-scoped client is created per request inside authenticateRequest;
// a route that skipped the guard would reach for it, so make that visible.
const createClient = vi.fn(() => {
  throw new Error("createClient must not be reached on an unauthenticated request");
});
vi.mock("@supabase/supabase-js", () => ({ createClient }));

const ROUTES_DIR = path.dirname(fileURLToPath(import.meta.url));

const ALL_ROUTE_FILES = (readdirSync(ROUTES_DIR, { recursive: true }) as string[])
  .map((p) => p.split(path.sep).join("/"))
  .filter((rel) => /\.tsx?$/.test(rel) && !/\.test\.tsx?$/.test(rel))
  .sort();

/** Mobile routes that are intentionally reachable without a user token.
 * Empty by design — every entry would need its own auth story. */
const PUBLIC_ROUTES = new Set<string>([]);

const SWEPT = ALL_ROUTE_FILES.filter((rel) => !PUBLIC_ROUTES.has(rel));

type ServerHandler = (args: {
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
      "move it out of src/routes/api/mobile/ or allowlist it with a reason",
  ).toBeTruthy();
  return handlers!;
}

function makeRequest(rel: string, method: string, headers: Record<string, string>): Request {
  const routePath = `/api/mobile/${rel.replace(/\.tsx?$/, "").replace(/\./g, "/")}`;
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`https://example.test${routePath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(hasBody ? { body: "{}" } : {}),
  });
}

async function expectAllHandlersReject(rel: string, headers: Record<string, string>) {
  const handlers = await loadHandlers(rel);
  fake.reset();
  createClient.mockClear();

  for (const [method, handler] of Object.entries(handlers)) {
    const res = await handler({ request: makeRequest(rel, method, headers), params: {} });
    expect(
      res.status,
      `${rel} ${method} returned ${res.status} for an unauthenticated request`,
    ).toBe(401);
  }

  expect(fake.calls.selects, `${rel} read from the DB before auth passed`).toEqual([]);
  expect(fake.calls.rpcs, `${rel} called an RPC before auth passed`).toEqual([]);
  expect(writeCount(fake), `${rel} wrote to the DB before auth passed`).toBe(0);
}

beforeEach(() => {
  // authenticateRequest needs these to get as far as rejecting the token
  // rather than 500-ing on configuration.
  vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
});

describe("mobile API routes reject unauthenticated callers", () => {
  it("found the mobile routes to sweep", () => {
    expect(SWEPT.length).toBeGreaterThanOrEqual(8);
    expect(SWEPT).toContain("emails.feed.ts");
    expect(SWEPT).toContain("contacts.ts");
    expect(SWEPT).toContain("meetings.ts");
  });

  it.each(SWEPT)("%s rejects a request with no Authorization header", async (rel) => {
    await expectAllHandlersReject(rel, {});
  });

  it.each(SWEPT)("%s rejects a non-Bearer Authorization header", async (rel) => {
    await expectAllHandlersReject(rel, { authorization: "Basic dXNlcjpwYXNz" });
  });

  it.each(SWEPT)("%s rejects an empty Bearer token", async (rel) => {
    await expectAllHandlersReject(rel, { authorization: "Bearer " });
  });

  it("every allowlisted public route still exists", () => {
    for (const rel of PUBLIC_ROUTES) {
      expect(ALL_ROUTE_FILES, `${rel} is allowlisted but no longer exists`).toContain(rel);
    }
  });
});
