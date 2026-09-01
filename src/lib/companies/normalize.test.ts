// Company-name normalization — the TS half of a two-implementation
// contract. normalizeCompanyNameDbSynced MUST stay in sync with the
// Postgres function public.normalize_company_name (the generated name_key
// column on contact_groups): drift silently splits company dedup keys.
//
// The cases live in __fixtures__/normalize-cases.json and are ALSO run
// against the real SQL function by
// tests/normalize-company-name-parity.integration.test.ts — add cases
// there, and both implementations get held to them.
import { describe, expect, it } from "vitest";
import { normalizeCompanyNameDbSynced } from "./normalize";
import spec from "./__fixtures__/normalize-cases.json";

describe("normalizeCompanyNameDbSynced", () => {
  it.each(spec.cases.map((c) => [c.input, c.expected] as const))("%j → %j", (input, expected) => {
    expect(normalizeCompanyNameDbSynced(input)).toBe(expected);
  });

  it("returns null for null/undefined input", () => {
    expect(normalizeCompanyNameDbSynced(null)).toBeNull();
    expect(normalizeCompanyNameDbSynced(undefined)).toBeNull();
  });

  it("strips only ONE trailing legal suffix (mild form, by design)", () => {
    // "Acme Inc LLC" keeps "inc" — the DB function behaves the same; the
    // aggressive brand collapsing lives in companyBrandKey instead.
    expect(normalizeCompanyNameDbSynced("Acme Inc LLC")).toBe("acme inc");
  });
});
