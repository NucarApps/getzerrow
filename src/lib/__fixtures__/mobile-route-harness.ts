// Shared harness for the /api/mobile/* route suites.
//
// The mobile routes are the contract with the Rork/Expo iOS app, which is
// released on its own cadence and cannot be redeployed in lockstep with the
// server, so these tests assert response BODIES rather than status codes
// alone. src/routes/api/mobile/auth-sweep.test.ts proves every handler
// refuses an unauthenticated caller; this harness is the other half — it
// drives the AUTHORISED path by standing in for authenticateRequest.
//
// It lives here rather than beside the routes because the auth sweep
// enumerates every file under src/routes/api/mobile/ and demands each one
// export a Route.
//
// Usage (the thunks are REQUIRED — vi.mock factories hoist above the
// test file's `const fake = makeSupabaseFake()`):
//
//   const fake = makeSupabaseFake();
//   vi.mock("@/integrations/supabase/client.server", () => ({
//     supabaseAdmin: mockSupabaseAdmin(() => fake),
//   }));
//   vi.mock("@/lib/mobile-auth.server", () => mockMobileAuth(() => fake));
//
//   const POST = serverHandler(await import("./meetings"), "POST");
//   const res = await POST(mobileRequest("/api/mobile/meetings", { body: { kind: "upcoming" } }));

import { expect } from "vitest";
import type { SupabaseFake, FakeRow, TableName } from "./supabase-fake";

/** The signed-in user every mobile route suite runs as. A real uuid, because
 * several route schemas validate ids with `z.string().uuid()`. */
export const MOBILE_USER = "11111111-1111-4111-8111-111111111111";
/** A second tenant, for "someone else's row is invisible / refused" tests. */
export const OTHER_USER = "22222222-2222-4222-8222-222222222222";

export type RouteHandlerArgs = { request: Request; params: Record<string, string> };
export type RouteHandler = (args: RouteHandlerArgs) => Response | Promise<Response>;
/** Called with just the request, the way every mobile route suite wants it. */
export type BoundHandler = (request: Request) => Promise<Response>;

type RouteModule = {
  Route?: { options?: { server?: { handlers?: Record<string, RouteHandler> } } };
};

/** Pull one method's handler off an imported route module and bind it to a
 * bare `request`, so a test reads `await POST(req)`. */
export function serverHandler(mod: unknown, method: string): BoundHandler {
  const handlers = (mod as RouteModule).Route?.options?.server?.handlers;
  const handler = handlers?.[method];
  expect(handler, `route module does not export a ${method} server handler`).toBeTypeOf("function");
  return async (request: Request) => handler!({ request, params: {} });
}

/** Body of `vi.mock("@/lib/mobile-auth.server", …)`: authenticates as
 * `MOBILE_USER` (or whatever the thunk reports) against the shared fake,
 * while keeping production's rule that a Bearer header must be present —
 * so a suite cannot accidentally prove a route works without one. */
export function mockMobileAuth(get: () => SupabaseFake, userId: () => string = () => MOBILE_USER) {
  return {
    authenticateRequest: async (request: Request) => {
      const header = request.headers.get("authorization");
      if (!header?.startsWith("Bearer ") || !header.slice("Bearer ".length).trim()) {
        throw new Response("Unauthorized", { status: 401 });
      }
      return {
        userId: userId(),
        supabase: get().client,
        token: header.slice("Bearer ".length).trim(),
      };
    },
  };
}

export type RequestInitLike = {
  method?: string;
  /** JSON-encoded into the body. */
  body?: unknown;
  /** Sent verbatim — for the malformed-JSON cases. */
  rawBody?: string;
  headers?: Record<string, string>;
  /** Drop the Authorization header (the auth stub then rejects). */
  anonymous?: boolean;
};

/** A request shaped like the iOS app's: POST, JSON, Bearer token. */
export function mobileRequest(path: string, init: RequestInitLike = {}): Request {
  const method = init.method ?? "POST";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.anonymous ? {} : { authorization: "Bearer test-token" }),
    ...init.headers,
  };
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`https://app.test${path}`, {
    method,
    headers,
    ...(hasBody && body !== undefined ? { body } : {}),
  });
}

/** Parse a handler's JSON body, asserting the status first so a failure
 * reports the status rather than a confusing shape mismatch. */
export async function jsonBody<T = unknown>(res: Response, expectedStatus?: number): Promise<T> {
  const text = await res.text();
  if (expectedStatus !== undefined) {
    expect(res.status, `unexpected status; body was ${text}`).toBe(expectedStatus);
  }
  return JSON.parse(text) as T;
}

/**
 * Emulate row-level security for one table on the shared fake: rows whose
 * `user_id` is not `userId` become invisible to every read of that table.
 *
 * The mobile routes that take `context.supabase` rely on RLS for tenant
 * isolation and add no `user_id` filter of their own; without this a seeded
 * foreign row would be returned and the "not found" branch could never be
 * reached honestly. Do NOT apply it to a table the route reads with the
 * service-role client on purpose (my_cards' handle-uniqueness check).
 */
export function rlsScoped(fake: SupabaseFake, table: TableName, userId: string) {
  fake.onSelect(table, () => ({
    data: (fake.rows(table) as FakeRow[]).filter((r) => r["user_id"] === userId),
  }));
}
