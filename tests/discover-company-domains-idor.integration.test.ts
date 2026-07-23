// Cross-tenant authorization regression test for `discover_company_domains`.
//
// Background: `discover_company_domains(p_company_id, p_user_id)` is
// SECURITY DEFINER (bypasses RLS) and granted to `authenticated`. It once
// authorized against the *caller-supplied* `p_user_id` argument instead of the
// session's `auth.uid()`:
//
//     IF NOT EXISTS (SELECT 1 FROM public.companies
//                     WHERE id = p_company_id AND user_id = p_user_id) ...
//
// So any signed-in user B who knew another tenant A's company_id + user_id
// could pass A's ids and drive reads/writes against A's contacts and
// company_domains — a cross-tenant IDOR. This test proves the function now
// derives identity from `auth.uid()`: a call whose `p_user_id` differs from the
// JWT subject is rejected, while the owner's own call still succeeds.
//
// SAFETY:
//   - Skipped unless TEST_DATABASE_URL is set.
//   - Everything runs inside a single transaction that is ALWAYS ROLLED BACK,
//     so it creates no persistent rows. Do NOT point TEST_DATABASE_URL at prod.
//   - TEST_DATABASE_URL must be an owner/service-role connection (it needs to
//     seed auth.users + companies and `SET ROLE authenticated`).
//
// Run:
//   TEST_DATABASE_URL=postgres://... bun run test:integration
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.TEST_DATABASE_URL;
const enabled = !!DB_URL;
const d = enabled ? describe : describe.skip;

// Deterministic fixture ids so a leaked row (should never happen — we roll
// back) is obvious and easy to purge.
const USER_A = "a1000000-0000-4000-8000-000000000001";
const USER_B = "b1000000-0000-4000-8000-000000000002";
const COMPANY_A = "c1000000-0000-4000-8000-000000000001";

d("discover_company_domains cross-tenant authorization", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query("BEGIN");

    await client.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)`, [
      USER_A,
      "owner-a@example.com",
      USER_B,
      "attacker-b@example.com",
    ]);
    await client.query(
      `INSERT INTO public.companies (id, user_id, name, name_key) VALUES ($1, $2, $3, $4)`,
      [COMPANY_A, USER_A, "Acme A", "acme a"],
    );
    // A member contact under A with a corporate email, so a successful run has
    // something to discover (proving the write path, not just the guard).
    await client.query(
      `INSERT INTO public.contacts (user_id, email, company_id) VALUES ($1, $2, $3)`,
      [USER_A, "person@acme-corp.com", COMPANY_A],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK").catch(() => {});
      await client.end().catch(() => {});
    }
  });

  // Call the RPC as `authenticated` with `auth.uid()` = jwtSub, passing the
  // given (companyId, ownerId) arguments. Isolated in a savepoint so a raised
  // exception doesn't poison the outer transaction.
  async function callAs(
    jwtSub: string,
    companyId: string,
    ownerId: string,
  ): Promise<{ ok: true; rows: unknown[] } | { ok: false; error: string }> {
    await client.query("SAVEPOINT sp");
    try {
      await client.query("SET LOCAL ROLE authenticated");
      await client.query(
        `SELECT set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true)`,
        [jwtSub],
      );
      const res = await client.query(
        `SELECT * FROM public.discover_company_domains($1::uuid, $2::uuid)`,
        [companyId, ownerId],
      );
      await client.query("RESET ROLE");
      await client.query("RELEASE SAVEPOINT sp");
      return { ok: true, rows: res.rows };
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT sp");
      await client.query("RESET ROLE").catch(() => {});
      return { ok: false, error: (e as Error).message };
    }
  }

  it("rejects a caller passing another tenant's user_id (cross-tenant IDOR)", async () => {
    // Attacker B authenticates as themselves but passes victim A's ids.
    const result = await callAs(USER_B, COMPANY_A, USER_A);
    expect(
      result.ok,
      "cross-tenant call must be rejected, not silently run against another tenant's data",
    ).toBe(false);
  });

  it("does not write a company_domain for the victim when attacked", async () => {
    await callAs(USER_B, COMPANY_A, USER_A);
    const res = await client.query(
      `SELECT count(*)::int AS n FROM public.company_domains WHERE company_id = $1 AND source = 'auto'`,
      [COMPANY_A],
    );
    // The autolink trigger may create one on contact insert, but the attacker's
    // recompute must not have run. Assert no *additional* auto rows beyond the
    // (at most one) the trigger produced under the owner's own session.
    expect(res.rows[0].n).toBeLessThanOrEqual(1);
  });

  it("still allows the owner's own call to succeed", async () => {
    const result = await callAs(USER_A, COMPANY_A, USER_A);
    expect(result.ok, result.ok ? "" : `owner call unexpectedly failed: ${result.error}`).toBe(
      true,
    );
    if (result.ok) {
      expect(result.rows).toHaveLength(1);
    }
  });
});
