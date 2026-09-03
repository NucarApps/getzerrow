// Shared plumbing for in-process tests of the /api/public/* server routes.
//
// A TanStack file route's handlers are reachable at
// `Route.options.server.handlers.POST`, but the generated type of
// `options.server` is a union with a builder function, so every call site
// otherwise repeats the same cast. `handlersOf` does it once, and throws a
// sentence rather than a TypeError when a route stops exposing handlers.
//
// The rest is the authorised-caller side of the cron contract that
// cron-auth.test.ts only ever exercises negatively: a request carrying the
// right CRON_SECRET, and a helper that runs it and parses the JSON body,
// because the body IS the contract these endpoints offer their callers.
//
// Lives in __fixtures__ so the coverage globs and the cron-auth route sweep
// both skip it — it is not a route.

export type RouteHandler = (ctx: {
  request: Request;
  params: Record<string, string>;
}) => Response | Promise<Response>;

type RouteLike = { options?: { server?: { handlers?: Record<string, RouteHandler> } } };

/** Every method handler a file route defines. */
export function handlersOf(route: unknown): Record<string, RouteHandler> {
  const handlers = (route as RouteLike).options?.server?.handlers;
  if (!handlers) throw new Error("route exposes no server.handlers");
  return handlers;
}

/** One method handler, by name. */
export function handler(route: unknown, method: string): RouteHandler {
  const found = handlersOf(route)[method];
  if (!found) throw new Error(`route exposes no ${method} handler`);
  return found;
}

/** The cron secret every helper here presents. Stub it with
 * `vi.stubEnv("CRON_SECRET", CRON_SECRET)` in the suite's beforeEach. */
export const CRON_SECRET = "test-cron-secret";

/** An authorised cron POST, with any query params the route reads. */
export function cronRequest(path: string, query: Record<string, string> = {}): Request {
  const url = new URL(`https://atzro.test/api/public/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}`, "content-type": "application/json" },
    body: "{}",
  });
}

/** Run a cron route's POST as an authorised caller and read the JSON body. */
export async function callCron<T>(
  route: unknown,
  path: string,
  query: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await handler(route, "POST")({ request: cronRequest(path, query), params: {} });
  return { status: res.status, body: (await res.json()) as T };
}
