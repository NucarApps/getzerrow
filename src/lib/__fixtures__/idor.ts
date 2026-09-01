// Test-only IDOR (cross-tenant) assertion helper.
//
// The app has two tenant-isolation mechanisms:
//   1. App-level guards on the service-role client — `assertOwnsContact` /
//      `assertOwnsCompany` (src/lib/ownership.ts) or inline
//      `row.user_id !== userId` checks. Every `supabaseAdmin` call site
//      that takes a client-supplied id is one of these — and each is a
//      potential IDOR if the guard is missing. THESE are unit-testable,
//      and this helper is the assertion for them.
//   2. RLS on the user-scoped client (`context.supabase`). Unit tests
//      cannot prove RLS; that lives in the DB-backed integration suite
//      (tests/*.integration.test.ts, template:
//      tests/discover-company-domains-idor.integration.test.ts).
//
// Usage (inside a *.functions.ts test file that already wires the
// server-fn stub and the shared supabase fake):
//
//   await expectDeniedCrossUser({
//     fake,
//     call: () => someServerFn({ data: { id: victimRowId }, context: { userId: ATTACKER } }),
//   });
//
// Asserts BOTH that the call rejects AND that no write of any kind was
// recorded while it ran — a guard that throws after mutating is still a
// finding.
//
// Lives in __fixtures__ so it is excluded from the `src/**/*.test.ts` glob
// and never ships.
import { expect } from "vitest";
import type { makeSupabaseFake } from "./supabase-fake";

type Fake = ReturnType<typeof makeSupabaseFake>;

function writeCount(fake: Fake): number {
  const { inserts, updates, upserts, deletes } = fake.calls;
  return inserts.length + updates.length + upserts.length + deletes.length;
}

export async function expectDeniedCrossUser(opts: {
  fake: Fake;
  /** Invoke the server fn impersonating the attacker (context.userId override). */
  call: () => Promise<unknown>;
  /** Expected rejection message (default: any error). */
  rejects?: string | RegExp;
}): Promise<void> {
  const before = writeCount(opts.fake);
  if (opts.rejects) {
    await expect(opts.call()).rejects.toThrow(opts.rejects);
  } else {
    await expect(opts.call()).rejects.toThrow();
  }
  expect(
    writeCount(opts.fake),
    "cross-tenant call must not record ANY write (a guard that throws after mutating is still an IDOR)",
  ).toBe(before);
}
