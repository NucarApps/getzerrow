// Test-only stub of @tanstack/react-start's `createServerFn` builder chain,
// so `.functions.ts` modules can be unit-tested in node without the server
// runtime. Mirrors the exact chain shape used across src/lib/gmail/*:
//
//   createServerFn({ method: "POST" })
//     .middleware([requireSupabaseAuth])
//     .validator((d) => schema.parse(d))
//     .handler(async ({ data, context }) => { ... })
//
// The terminal `.handler(fn)` returns a plain async function, directly
// callable as `serverFn({ data })`. The registered validator runs
// first (so zod validation failures reject just like production), then the
// handler is invoked with `context.userId = TEST_USER` — middleware entries
// are accepted and ignored, since auth middleware is mocked separately.
//
// Lives in __fixtures__ so it is excluded from the `src/**/*.test.ts` glob
// and never ships. Consume inside a vi.mock async factory:
//
//   vi.mock("@tanstack/react-start", async () => {
//     const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
//     return { createServerFn };
//   });
//
// Per-call context overrides are supported for impersonation tests:
//   serverFn({ data, context: { userId: "someone-else" } })

/** The authenticated user id every stubbed handler sees by default. */
export const TEST_USER = "test-user-1";

/** Call a stubbed server fn as a different user (impersonation for IDOR
 * tests). Exists because the REAL createServerFn's call signature has no
 * `context` option — only the stub honors it — so a plain call site fails
 * typecheck. Usage: `impersonate(deleteContact, ATTACKER)({ data: {...} })`. */
export function impersonate(fn: unknown, userId: string) {
  const stubbed = fn as (args?: {
    data?: unknown;
    context?: Record<string, unknown>;
  }) => Promise<unknown>;
  return (args?: { data?: unknown }) => stubbed({ ...args, context: { userId } });
}

type HandlerCtx = { data: unknown; context: { userId: string } & Record<string, unknown> };
type CallArgs = { data?: unknown; context?: Record<string, unknown> } | undefined;

export function createServerFn(_opts?: unknown) {
  let registeredValidator: ((input: unknown) => unknown) | null = null;

  const builder = {
    middleware(_mws: unknown[]) {
      return builder;
    },
    validator(v: (input: never) => unknown) {
      registeredValidator = v as (input: unknown) => unknown;
      return builder;
    },
    /** Deprecated alias kept in step with the real API (`inputValidator`
     * still works upstream but warns at build time). */
    inputValidator(v: (input: never) => unknown) {
      return builder.validator(v);
    },
    handler(fn: (ctx: HandlerCtx) => unknown) {
      return async (args?: CallArgs) => {
        const data = registeredValidator ? registeredValidator(args?.data) : args?.data;
        return fn({ data, context: { userId: TEST_USER, ...(args?.context ?? {}) } });
      };
    },
  };
  return builder;
}
