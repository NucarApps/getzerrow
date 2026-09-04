// Contract for the migration-smoke-test endpoint.
//
// This is also the file that proves the cron-auth sweep is not passing
// vacuously. That sweep only ever asserts 401s, which a route that 401s
// unconditionally would satisfy — so at least one route has to show that the
// CORRECT secret reaches the handler body and produces real work. health.ts
// is the cheapest such route: no side effects, and a body that says exactly
// what it probed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { EXPECTED_COLUMNS, EXPECTED_FUNCTIONS, EXPECTED_VIEWS, Route } from "./health";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

type HealthBody = {
  ok: boolean;
  checks: { views: number; functions: number; columns: number };
  missing: Array<{ kind: string; name: string }>;
  encryption_leaks: Record<string, number> | null;
};

/** Seed the catalog probes as a fully-migrated database would answer them. */
function seedHealthySchema(opts: { skipFunctions?: string[]; skipColumns?: string[] } = {}) {
  fake.seedRaw(
    "pg_proc",
    EXPECTED_FUNCTIONS.filter((f) => !opts.skipFunctions?.includes(f)).map((proname) => ({
      proname,
    })),
  );
  fake.seedRaw(
    "information_schema.columns",
    EXPECTED_COLUMNS.filter((c) => !opts.skipColumns?.includes(`${c.table}.${c.column}`)).map(
      (c) => ({ table_schema: "public", table_name: c.table, column_name: c.column }),
    ),
  );
}

beforeEach(() => {
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
});

describe("authorised requests reach the handler body", () => {
  it("returns 200 and a full schema report for a correct Bearer secret", async () => {
    seedHealthySchema();
    fake.onRpc("audit_encryption_leaks", () => ({ data: [{ emails_missing_ct: 0 }] }));

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      checks: {
        views: EXPECTED_VIEWS.length,
        functions: EXPECTED_FUNCTIONS.length,
        columns: EXPECTED_COLUMNS.length,
      },
      missing: [],
      encryption_leaks: { emails_missing_ct: 0 },
    });
  });

  it("accepts the x-cron-secret header form of the same secret", async () => {
    seedHealthySchema();
    const request = new Request("https://atzro.test/api/public/health", {
      method: "POST",
      headers: { "x-cron-secret": CRON_SECRET },
      body: "{}",
    });

    const res = await handler(Route, "POST")({ request, params: {} });

    expect(res.status).toBe(200);
  });

  it("accepts a secret held only in the database, via cron_secret_matches", async () => {
    seedHealthySchema();
    vi.stubEnv("CRON_SECRET", undefined);
    fake.onRpc("cron_secret_matches", (args) => ({ data: args.provided === "db-held-secret" }));

    const request = new Request("https://atzro.test/api/public/health", {
      method: "POST",
      headers: { authorization: "Bearer db-held-secret" },
      body: "{}",
    });
    const res = await handler(Route, "POST")({ request, params: {} });

    expect(res.status).toBe(200);
    expect(fake.calls.rpcs).toContainEqual({
      fn: "cron_secret_matches",
      args: { provided: "db-held-secret" },
    });
  });

  it("still refuses a wrong secret when the database fallback says no", async () => {
    seedHealthySchema();
    vi.stubEnv("CRON_SECRET", undefined);
    fake.onRpc("cron_secret_matches", () => ({ data: false }));

    const request = new Request("https://atzro.test/api/public/health", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: "{}",
    });
    const res = await handler(Route, "POST")({ request, params: {} });

    expect(res.status).toBe(401);
  });
});

describe("schema probes", () => {
  it("reports 503 and names a missing function", async () => {
    seedHealthySchema({ skipFunctions: ["claim_message_jobs"] });

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.missing).toStrictEqual([{ kind: "function", name: "claim_message_jobs" }]);
  });

  it("reports 503 and names a missing column", async () => {
    seedHealthySchema({ skipColumns: ["emails.body_text_enc"] });

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(503);
    expect(body.missing).toStrictEqual([{ kind: "column", name: "emails.body_text_enc" }]);
  });

  it("reports every expected object as missing against an empty catalog", async () => {
    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(503);
    expect(body.missing).toHaveLength(EXPECTED_FUNCTIONS.length + EXPECTED_COLUMNS.length);
    expect(body.missing.filter((m) => m.kind === "function")).toHaveLength(
      EXPECTED_FUNCTIONS.length,
    );
  });

  it("queries the column catalog scoped to the public schema and the tables it needs", async () => {
    seedHealthySchema();

    await callCron<HealthBody>(Route, "health");

    const colSelect = fake.calls.selects.find((s) => s.table === "information_schema.columns");
    expect(colSelect?.filters).toStrictEqual([
      { op: "eq", col: "table_schema", value: "public", extra: undefined },
      {
        op: "in",
        col: "table_name",
        value: [...new Set(EXPECTED_COLUMNS.map((c) => c.table))],
        extra: undefined,
      },
    ]);
  });
});

describe("view probes", () => {
  // EXPECTED_VIEWS is empty today, so the view loops are unreachable by
  // data. Adding a name for the duration of a test exercises the code that
  // goes live the moment a view IS listed — otherwise the first entry
  // anyone adds would be running untested.
  const withExpectedView = async (name: string, run: () => Promise<void>) => {
    EXPECTED_VIEWS.push(name);
    try {
      await run();
    } finally {
      EXPECTED_VIEWS.length = 0;
    }
  };

  it("passes when the catalog lists the view", async () => {
    await withExpectedView("email_search_index", async () => {
      seedHealthySchema();
      fake.seedRaw("pg_views", [{ schemaname: "public", viewname: "email_search_index" }]);

      const { status, body } = await callCron<HealthBody>(Route, "health");

      expect(status).toBe(200);
      expect(body.missing).toStrictEqual([]);
      expect(body.checks.views).toBe(1);
    });
  });

  it("names a view the catalog does not list", async () => {
    await withExpectedView("email_search_index", async () => {
      seedHealthySchema();

      const { status, body } = await callCron<HealthBody>(Route, "health");

      expect(status).toBe(503);
      expect(body.missing).toStrictEqual([{ kind: "view", name: "email_search_index" }]);
    });
  });

  it("scopes the view query to the public schema", async () => {
    await withExpectedView("email_search_index", async () => {
      seedHealthySchema();
      await callCron<HealthBody>(Route, "health");
      expect(fake.calls.selects.find((s) => s.table === "pg_views")?.filters).toStrictEqual([
        { op: "eq", col: "schemaname", value: "public", extra: undefined },
        { op: "in", col: "viewname", value: ["email_search_index"], extra: undefined },
      ]);
    });
  });

  it("falls back to a to_regclass probe when pg_views is not exposed", async () => {
    // PostgREST does not expose pg_views by default; the fallback is the
    // only thing keeping the view check alive on such a deployment.
    await withExpectedView("email_search_index", async () => {
      seedHealthySchema();
      fake.onSelect("pg_views", () => {
        throw new Error("relation pg_views is not exposed");
      });
      fake.onRpc("to_regclass", () => ({ data: "public.email_search_index" }));

      const { status, body } = await callCron<HealthBody>(Route, "health");

      expect(status).toBe(200);
      expect(body.missing).toStrictEqual([]);
      expect(fake.calls.rpcs).toContainEqual({
        fn: "to_regclass",
        args: { obj: "public.email_search_index" },
      });
    });
  });

  it("reports the view missing when the fallback probe finds nothing", async () => {
    await withExpectedView("email_search_index", async () => {
      seedHealthySchema();
      fake.onSelect("pg_views", () => {
        throw new Error("relation pg_views is not exposed");
      });
      fake.onRpc("to_regclass", () => ({ data: null }));

      const { status, body } = await callCron<HealthBody>(Route, "health");

      expect(status).toBe(503);
      expect(body.missing).toStrictEqual([{ kind: "view", name: "email_search_index" }]);
    });
  });
});

describe("catalog probes that are not exposed", () => {
  it("skips the function check rather than reporting false missing", async () => {
    // pg_proc unreachable must not be read as "every function is gone" —
    // that would page someone for a healthy database.
    seedHealthySchema();
    fake.onSelect("pg_proc", () => {
      throw new Error("relation pg_proc is not exposed");
    });

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(200);
    expect(body.missing).toStrictEqual([]);
  });

  it("skips the column check rather than reporting false missing", async () => {
    seedHealthySchema();
    fake.onSelect("information_schema.columns", () => {
      throw new Error("information_schema is not exposed");
    });

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(200);
    expect(body.missing).toStrictEqual([]);
  });
});

describe("encryption-leak audit", () => {
  it("fails the health check when any leak counter is non-zero", async () => {
    seedHealthySchema();
    fake.onRpc("audit_encryption_leaks", () => ({
      data: [{ emails_missing_ct: 0, search_index_body_lexemes: 4 }],
    }));

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      missing: [],
      encryption_leaks: { emails_missing_ct: 0, search_index_body_lexemes: 4 },
    });
  });

  it("coerces string counters (PostgREST returns bigints as strings) to numbers", async () => {
    seedHealthySchema();
    fake.onRpc("audit_encryption_leaks", () => ({ data: [{ oauth_missing_ct: "0" }] }));

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(200);
    expect(body.encryption_leaks).toStrictEqual({ oauth_missing_ct: 0 });
  });

  it("accepts a single row rather than an array from the audit RPC", async () => {
    seedHealthySchema();
    fake.onRpc("audit_encryption_leaks", () => ({ data: { emails_missing_ct: 2 } }));

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(503);
    expect(body.encryption_leaks).toStrictEqual({ emails_missing_ct: 2 });
  });

  it("reads a null counter as zero rather than NaN", async () => {
    seedHealthySchema();
    fake.onRpc("audit_encryption_leaks", () => ({ data: [{ emails_missing_ct: null }] }));

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(200);
    expect(body.encryption_leaks).toStrictEqual({ emails_missing_ct: 0 });
  });

  it("ignores a counter that does not parse as a number", async () => {
    // A non-numeric column would otherwise make the sum NaN, and NaN !== 0
    // fails the health check for every deployment.
    seedHealthySchema();
    fake.onRpc("audit_encryption_leaks", () => ({
      data: [{ measured_at: "2026-09-04T00:00:00Z", emails_missing_ct: 0 }],
    }));

    const { status, body } = await callCron<HealthBody>(Route, "health");

    // The point is the 200: a non-numeric column must not make the leak
    // sum NaN, which is never === 0 and would fail every deployment. (It
    // reaches the client as null — NaN has no JSON spelling.)
    expect(status).toBe(200);
    expect(body.encryption_leaks).toStrictEqual({ measured_at: null, emails_missing_ct: 0 });
  });

  it("treats a missing audit RPC as no leaks rather than a failure", async () => {
    seedHealthySchema();

    const { status, body } = await callCron<HealthBody>(Route, "health");

    expect(status).toBe(200);
    expect(body.encryption_leaks).toBeNull();
  });
});

describe("method stub", () => {
  it("answers GET with 405 rather than running the probes", async () => {
    const res = await handler(Route, "GET")({ request: cronRequest("health"), params: {} });

    expect(res.status).toBe(405);
    expect(await res.text()).toBe("Use POST");
    expect(fake.calls.selects).toStrictEqual([]);
  });
});
