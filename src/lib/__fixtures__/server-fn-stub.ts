// Test-only stub of @tanstack/react-start's `createServerFn` builder chain,
// so `.functions.ts` modules can be unit-tested in node without the server
// runtime. Mirrors the exact chain shape used across src/lib/gmail/*:
//
//   createServerFn({ method: "POST" })
//     .middleware([requireSupabaseAuth])
//     .inputValidator((d) => schema.parse(d))
//     .handler(async ({ data, context }) => { ... })
//
// The terminal `.handler(fn)` returns a plain async function, directly
// callable as `serverFn({ data })`. The registered inputValidator runs
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

type HandlerCtx = { data: unknown; context: { userId: string } & Record<string, unknown> };
type CallArgs = { data?: unknown; context?: Record<string, unknown> } | undefined;

export function createServerFn(_opts?: unknown) {
  let validator: ((input: unknown) => unknown) | null = null;

  const builder = {
    middleware(_mws: unknown[]) {
      return builder;
    },
    inputValidator(v: (input: never) => unknown) {
      validator = v as (input: unknown) => unknown;
      return builder;
    },
    handler(fn: (ctx: HandlerCtx) => unknown) {
      return async (args?: CallArgs) => {
        const data = validator ? validator(args?.data) : args?.data;
        return fn({ data, context: { userId: TEST_USER, ...(args?.context ?? {}) } });
      };
    },
  };
  return builder;
}
