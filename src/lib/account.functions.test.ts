// Account erasure (src/lib/account.functions.ts).
//
// The first suite is schema-derived: it replays every migration to find each
// table that stores user data and asserts deleteAccount reaches it — either
// directly (ACCOUNT_ERASURE_TABLES), by a non-user_id predicate
// (ACCOUNT_ERASURE_INDIRECT), or through an `ON DELETE CASCADE` chain rooted
// in one of those (or in auth.users). This is the test that was missing when
// `tasks` — user_id NOT NULL, no FK — was added and never erased.
//
// The second suite pins the runtime contract: every table gets its delete,
// a single table failure is counted but does not abort, and a failed auth
// delete aborts without the audit line.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";

const fake = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const stopWatch = vi.fn(async (_accountId: string) => {});
vi.mock("./gmail.server", () => ({ stopWatch: (id: string) => stopWatch(id) }));
const revokeGoogleOAuthForAccount = vi.fn(async (_accountId: string) => {});
vi.mock("./google-oauth.server", () => ({
  revokeGoogleOAuthForAccount: (id: string) => revokeGoogleOAuthForAccount(id),
}));
const logError = vi.fn();
const logAudit = vi.fn();
vi.mock("./log.server", () => ({
  logError: (...a: unknown[]) => logError(...a),
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

import {
  deleteAccount,
  ACCOUNT_ERASURE_TABLES,
  ACCOUNT_ERASURE_INDIRECT,
} from "./account.functions";

/* -------------------------------------------------------------------------- */
/* Schema replay                                                               */
/* -------------------------------------------------------------------------- */

type TableInfo = { hasUserId: boolean; cascadeFrom: Set<string> };

/** Minimal migration replay: CREATE TABLE (paren-balanced), DROP TABLE,
 * ALTER TABLE ... ADD COLUMN user_id / ADD CONSTRAINT ... REFERENCES. */
function replayMigrations(): Map<string, TableInfo> {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const tables = new Map<string, TableInfo>();
  const get = (name: string) => {
    let t = tables.get(name);
    if (!t) {
      t = { hasUserId: false, cascadeFrom: new Set() };
      tables.set(name, t);
    }
    return t;
  };
  const cascadeRe =
    /references\s+(?:public\.|auth\.)?"?(\w+)"?\s*(?:\([^)]*\))?\s*on\s+delete\s+cascade/gi;

  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");

    // CREATE TABLE [IF NOT EXISTS] [public.]name ( ...balanced... )
    const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?\s*\(/gi;
    let m: RegExpExecArray | null;
    while ((m = createRe.exec(sql))) {
      const name = m[1]!;
      let depth = 1;
      let i = createRe.lastIndex;
      while (i < sql.length && depth > 0) {
        const ch = sql[i];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        i++;
      }
      const body = sql.slice(createRe.lastIndex, i - 1);
      const t = get(name);
      if (/\buser_id\b/i.test(body)) t.hasUserId = true;
      let c: RegExpExecArray | null;
      cascadeRe.lastIndex = 0;
      while ((c = cascadeRe.exec(body))) t.cascadeFrom.add(c[1]!);
    }

    // Statement-initial only: `ALTER PUBLICATION ... DROP TABLE x` must not
    // count as dropping x.
    const dropRe = /(?:^|;)\s*drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?/gim;
    while ((m = dropRe.exec(sql))) tables.delete(m[1]!);

    const alterRe =
      /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?"?(\w+)"?([^;]*);/gi;
    while ((m = alterRe.exec(sql))) {
      const t = tables.get(m[1]!);
      if (!t) continue;
      const body = m[2]!;
      if (/add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?user_id"?\b/i.test(body))
        t.hasUserId = true;
      let c: RegExpExecArray | null;
      cascadeRe.lastIndex = 0;
      while ((c = cascadeRe.exec(body))) t.cascadeFrom.add(c[1]!);
    }
  }
  return tables;
}

describe("deleteAccount erases every user-data table in the schema", () => {
  const tables = replayMigrations();

  it("the schema replay found the well-known tables (parser sanity)", () => {
    for (const name of ["emails", "contacts", "tasks", "gmail_accounts", "folder_filters"]) {
      expect(tables.has(name), `parser missed ${name}`).toBe(true);
    }
    expect(tables.get("tasks")?.hasUserId).toBe(true);
    expect(tables.get("folder_filters")?.hasUserId).toBe(false);
  });

  it("every table listed for erasure still exists", () => {
    for (const name of [...ACCOUNT_ERASURE_TABLES, ...ACCOUNT_ERASURE_INDIRECT]) {
      expect(tables.has(name), `${name} is listed for erasure but no migration creates it`).toBe(
        true,
      );
    }
  });

  it("every table with a user_id column is reached directly, indirectly, or by cascade", () => {
    const erased = new Set<string>([
      "users",
      ...ACCOUNT_ERASURE_TABLES,
      ...ACCOUNT_ERASURE_INDIRECT,
    ]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, t] of tables) {
        if (erased.has(name)) continue;
        for (const parent of t.cascadeFrom) {
          if (erased.has(parent)) {
            erased.add(name);
            changed = true;
            break;
          }
        }
      }
    }
    const missing = [...tables]
      .filter(([name, t]) => t.hasUserId && !erased.has(name))
      .map(([name]) => name)
      .sort();
    expect(
      missing,
      "user-data tables deleteAccount never touches — add them to ACCOUNT_ERASURE_TABLES or give them an ON DELETE CASCADE FK",
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Runtime contract                                                            */
/* -------------------------------------------------------------------------- */

describe("deleteAccount runtime", () => {
  beforeEach(() => {
    fake.reset();
    fake.onAuth("deleteUser", () => ({ data: null, error: null }));
  });

  function deletesFor(table: string) {
    return fake.calls.deletes.filter((d) => d.table === table);
  }

  it("stops watches, revokes OAuth, deletes every table scoped to the user, then the auth user", async () => {
    fake.seed("gmail_accounts", [
      { id: "acc-1", user_id: TEST_USER, email_address: "a@x.com" },
      { id: "acc-2", user_id: TEST_USER, email_address: "b@x.com" },
    ]);
    fake.seed("folders", [
      { id: "f-1", user_id: TEST_USER },
      { id: "f-2", user_id: TEST_USER },
    ]);

    const res = await deleteAccount({});
    expect(res).toEqual({ ok: true });

    expect(stopWatch.mock.calls.map((c) => c[0])).toEqual(["acc-1", "acc-2"]);
    expect(revokeGoogleOAuthForAccount.mock.calls.map((c) => c[0])).toEqual(["acc-1", "acc-2"]);

    for (const table of ACCOUNT_ERASURE_TABLES) {
      const d = deletesFor(table);
      expect(d, `no delete recorded for ${table}`).toHaveLength(1);
      expect(d[0]!.filters).toEqual([{ op: "eq", col: "user_id", value: TEST_USER }]);
    }
    expect(deletesFor("folder_filters")[0]!.filters).toEqual([
      { op: "in", col: "folder_id", value: ["f-1", "f-2"] },
    ]);
    expect(deletesFor("card_events")[0]!.filters).toEqual([
      { op: "eq", col: "owner_user_id", value: TEST_USER },
    ]);
    expect(deletesFor("pubsub_events")[0]!.filters).toEqual([
      { op: "in", col: "email_address", value: ["a@x.com", "b@x.com"] },
    ]);

    expect(fake.calls.auth).toEqual([{ method: "deleteUser", args: TEST_USER }]);
    expect(logAudit).toHaveBeenCalledWith("account.deleted", {
      user_id: TEST_USER,
      gmail_accounts: 2,
      delete_errors: 0,
    });
  });

  it("a stopWatch/revoke failure is logged and does not stop the erasure", async () => {
    fake.seed("gmail_accounts", [{ id: "acc-1", user_id: TEST_USER, email_address: "a@x.com" }]);
    stopWatch.mockRejectedValueOnce(new Error("gmail down"));
    revokeGoogleOAuthForAccount.mockRejectedValueOnce(new Error("google down"));
    await expect(deleteAccount({})).resolves.toEqual({ ok: true });
    expect(logError).toHaveBeenCalledWith(
      "account.delete.stop_watch_failed",
      { user_id: TEST_USER, account_id: "acc-1" },
      expect.any(Error),
    );
    expect(logError).toHaveBeenCalledWith(
      "account.delete.revoke_failed",
      { user_id: TEST_USER, account_id: "acc-1" },
      expect.any(Error),
    );
    expect(fake.calls.auth).toHaveLength(1);
  });

  it("a single table failure is counted in the audit line; every other table is still deleted", async () => {
    fake.onDelete("tasks", () => ({ message: "permission denied" }));
    await expect(deleteAccount({})).resolves.toEqual({ ok: true });
    expect(logError).toHaveBeenCalledWith(
      "account.delete.table_failed",
      { user_id: TEST_USER, table: "tasks" },
      { message: "permission denied" },
    );
    expect(fake.calls.deletes.map((d) => d.table)).toEqual(
      expect.arrayContaining([...ACCOUNT_ERASURE_TABLES]),
    );
    expect(logAudit).toHaveBeenCalledWith(
      "account.deleted",
      expect.objectContaining({ delete_errors: 1 }),
    );
  });

  it("skips the folder_filters and pubsub_events deletes when there is nothing to scope them to", async () => {
    await deleteAccount({});
    expect(deletesFor("folder_filters")).toHaveLength(0);
    expect(deletesFor("pubsub_events")).toHaveLength(0);
  });

  it("a failed auth delete throws and never writes the audit line", async () => {
    fake.onAuth("deleteUser", () => ({ error: { message: "auth unavailable" } }));
    await expect(deleteAccount({})).rejects.toThrow("Failed to delete account: auth unavailable");
    expect(logAudit).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      "account.delete.auth_failed",
      { user_id: TEST_USER },
      { message: "auth unavailable" },
    );
  });
});
