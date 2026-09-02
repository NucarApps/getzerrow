// Test-only helper for server functions that read and write
// through `context.supabase` — the user-scoped (RLS) client — rather than
// `supabaseAdmin`. The shared server-fn stub only injects `context.userId`,
// so these fns would see `context.supabase === undefined`.
//
// Unit tests cannot prove RLS itself (that lives in the DB-backed
// integration suite). What they CAN prove is the app's behaviour given the
// row visibility RLS produces: seed the fake with only the rows the caller
// is allowed to see, and assert the fn denies and writes nothing. Tests
// doing that carry an `// RLS-RELIANCE:` comment.
//
// Lives in __fixtures__ so it is excluded from the coverage/test globs.
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import type { SupabaseFake } from "@/lib/__fixtures__/supabase-fake";

type ServerFnLike = (args: never) => Promise<unknown>;

/**
 * Call a stubbed server fn with both `context.userId` and an RLS-client
 * stand-in in `context.supabase`. Mirrors `impersonate` from
 * `server-fn-stub` (the real `createServerFn` call signature has no
 * `context` option, so the cast is unavoidable) while preserving the
 * handler's return type.
 */
export function callWithRlsClient<F extends ServerFnLike>(
  fn: F,
  opts: { fake: SupabaseFake; userId?: string },
): (args?: { data?: unknown }) => Promise<Awaited<ReturnType<F>>> {
  const stubbed = fn as unknown as (args?: {
    data?: unknown;
    context?: Record<string, unknown>;
  }) => Promise<Awaited<ReturnType<F>>>;
  return (args) =>
    stubbed({
      ...args,
      context: { userId: opts.userId ?? TEST_USER, supabase: opts.fake.client },
    });
}
