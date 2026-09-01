// TS ↔ SQL parity for company-name normalization.
//
// public.normalize_company_name backs the GENERATED name_key column on
// contact_groups; src/lib/companies/normalize.ts re-implements it in TS.
// If the two drift, dedup keys computed in the app disagree with the keys
// the database stores — companies silently split. Both implementations are
// held to the SAME table of cases:
//   src/lib/companies/__fixtures__/normalize-cases.json
// (the TS half runs in the unit suite: src/lib/companies/normalize.test.ts).
//
// Skipped unless TEST_DATABASE_URL is set (CI starts a migrated local
// Supabase Postgres; see .github/workflows/ci.yml "integration" job).
// Read-only — SELECTs against an IMMUTABLE function, no fixtures needed.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import spec from "../src/lib/companies/__fixtures__/normalize-cases.json";
import { normalizeCompanyNameDbSynced } from "../src/lib/companies/normalize";

const DB_URL = process.env.TEST_DATABASE_URL;
const enabled = !!DB_URL;
const d = enabled ? describe : describe.skip;

d("public.normalize_company_name matches the TS implementation", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  it.each(spec.cases.map((c) => [c.input, c.expected] as const))(
    "%j → %j (SQL and TS agree)",
    async (input, expected) => {
      const { rows } = await client.query<{ out: string | null }>(
        "SELECT public.normalize_company_name($1) AS out",
        [input],
      );
      const row = rows[0];
      if (!row) throw new Error("query returned no row");
      expect(row.out).toBe(expected);
      expect(normalizeCompanyNameDbSynced(input)).toBe(row.out);
    },
  );

  it("SQL returns NULL for NULL input, matching the TS null path", async () => {
    const { rows } = await client.query<{ out: string | null }>(
      "SELECT public.normalize_company_name(NULL) AS out",
    );
    const row = rows[0];
    if (!row) throw new Error("query returned no row");
    expect(row.out).toBeNull();
    expect(normalizeCompanyNameDbSynced(null)).toBeNull();
  });
});
