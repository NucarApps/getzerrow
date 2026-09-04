// Brand-logo provider picks (company-logo.functions.ts). A pick is a small
// row, but changing it fans out into three caches and two devices, and
// every step of that fan-out is best-effort — which is exactly why it
// needs pinning: a swallowed failure looks identical to a step that was
// silently dropped in a refactor.
//
//   * `provider` is an INDEX into the provider list, so the upper bound is
//     a data contract with LOGO_PROVIDER_LABELS — a widened schema stores
//     an index that resolves to no provider at all,
//   * domains are normalized (trimmed, lowercased) and validated before
//     they reach the DB, and sourceDomain collapses to null when it equals
//     the domain rather than storing a self-referential alias,
//   * the upsert conflict target is `user_id,domain`, which is what makes
//     re-picking a provider an update rather than a duplicate row,
//   * on every change: the CardDAV resync nonce is bumped (so iPhone
//     re-polls), linked contacts are marked photo-dirty (so the next Google
//     push carries the new bytes), and the TTL-cached known-logo SHA set is
//     dropped — skipping the last one lets the echo guard run stale for up
//     to five minutes and promote the new logo into a contact's avatar,
//   * those three are best-effort by design: each failure is swallowed and
//     the pick still succeeds. The DB write is NOT — it throws.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER, impersonate } from "@/lib/__fixtures__/server-fn-stub";
import { LOGO_PROVIDER_COUNT } from "@/lib/logo-providers";

const rls = makeSupabaseFake({ applyWrites: true });
const admin = makeSupabaseFake();

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => admin),
}));

const invalidateKnownCompanyLogoShaCache = vi.fn();
vi.mock("@/lib/contacts/known-logos.server", () => ({
  invalidateKnownCompanyLogoShaCache: (...a: unknown[]) =>
    invalidateKnownCompanyLogoShaCache(...(a as [])),
}));

const bumpResyncNonce = vi.fn(async () => {});
vi.mock("@/lib/carddav/settings.functions", () => ({
  bumpResyncNonce: (...a: unknown[]) => bumpResyncNonce(...(a as [])),
}));

const markGooglePhotoDirtyMany = vi.fn(async () => {});
vi.mock("@/lib/google-contacts/mark-dirty.server", () => ({
  markGooglePhotoDirtyMany: (...a: unknown[]) => markGooglePhotoDirtyMany(...(a as [])),
}));

const { listCompanyLogoChoices, setCompanyLogoChoice, clearCompanyLogoChoice } =
  await import("./company-logo.functions");

const ctx = { supabase: rls.supabaseAdmin };
const asUser = <T>(fn: T) => impersonate(fn, TEST_USER, ctx);
const setChoice = (data: unknown) => asUser(setCompanyLogoChoice)({ data });
const clearChoice = (data: unknown) => asUser(clearCompanyLogoChoice)({ data });

/** Link acme.com to a company with two contacts, so the photo-dirty fan-out
 * has something to find. */
function seedLinkedCompany() {
  admin.seedRaw("company_domains", [
    { user_id: TEST_USER, domain: "acme.com", company_id: "co-1" },
  ]);
  admin.seedRaw("contacts", [
    { id: "c1", user_id: TEST_USER, company_id: "co-1" },
    { id: "c2", user_id: TEST_USER, company_id: "co-1" },
    { id: "c3", user_id: TEST_USER, company_id: "co-2" },
  ]);
}

beforeEach(() => {
  rls.reset();
  admin.reset();
  vi.clearAllMocks();
  bumpResyncNonce.mockResolvedValue(undefined);
  markGooglePhotoDirtyMany.mockResolvedValue(undefined);
});

describe("listCompanyLogoChoices", () => {
  it("returns only the caller's picks", async () => {
    rls.seedRaw("company_logo_choices", [
      { user_id: TEST_USER, domain: "acme.com", provider: 2, source_domain: null },
    ]);
    const res = await asUser(listCompanyLogoChoices)();
    expect(res).toEqual([
      { user_id: TEST_USER, domain: "acme.com", provider: 2, source_domain: null },
    ]);
    expect(rls.calls.selects[0]).toMatchObject({
      table: "company_logo_choices",
      filters: [{ op: "eq", col: "user_id", value: TEST_USER }],
    });
  });

  it("throws the read error rather than reporting no picks", async () => {
    rls.onSelect("company_logo_choices", () => ({ message: "read failed" }));
    await expect(asUser(listCompanyLogoChoices)()).rejects.toThrow("read failed");
  });
});

describe("setCompanyLogoChoice validation", () => {
  it("normalizes the domain before storing it", async () => {
    await setChoice({ domain: "  ACME.com  ", provider: 1 });
    expect(rls.calls.upserts[0]?.payload).toMatchObject({ domain: "acme.com" });
  });

  it("rejects a malformed domain", async () => {
    for (const domain of ["", "acme", "http://acme.com", "acme .com", "-acme.com", "acme.c"]) {
      await expect(setChoice({ domain, provider: 0 })).rejects.toThrow();
    }
    expect(rls.calls.upserts).toEqual([]);
  });

  it("bounds provider to the real provider list", async () => {
    // The stored value is an index into LOGO_PROVIDER_LABELS; anything
    // outside it resolves to no provider at render time.
    await expect(
      setChoice({ domain: "acme.com", provider: LOGO_PROVIDER_COUNT }),
    ).rejects.toThrow();
    await expect(setChoice({ domain: "acme.com", provider: -1 })).rejects.toThrow();
    await expect(setChoice({ domain: "acme.com", provider: 1.5 })).rejects.toThrow();
    await expect(
      setChoice({ domain: "acme.com", provider: LOGO_PROVIDER_COUNT - 1 }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects a malformed sourceDomain", async () => {
    await expect(
      setChoice({ domain: "acme.com", provider: 0, sourceDomain: "nope" }),
    ).rejects.toThrow();
  });
});

describe("setCompanyLogoChoice write", () => {
  it("upserts on user_id,domain so re-picking replaces rather than duplicates", async () => {
    const res = await setChoice({ domain: "acme.com", provider: 3 });

    expect(res).toEqual({ ok: true });
    expect(rls.calls.upserts[0]).toMatchObject({
      table: "company_logo_choices",
      payload: { user_id: TEST_USER, domain: "acme.com", provider: 3, source_domain: null },
      options: { onConflict: "user_id,domain" },
    });
  });

  it("stores a distinct sourceDomain but collapses a self-referential one", async () => {
    await setChoice({ domain: "acme.com", provider: 0, sourceDomain: "acmecorp.com" });
    expect(rls.calls.upserts[0]?.payload).toMatchObject({ source_domain: "acmecorp.com" });

    rls.reset();
    await setChoice({ domain: "acme.com", provider: 0, sourceDomain: "ACME.com" });
    expect(rls.calls.upserts[0]?.payload).toMatchObject({ source_domain: null });
  });

  it("throws on a write failure without running the fan-out", async () => {
    rls.onUpsert("company_logo_choices", () => ({ message: "upsert failed" }));
    await expect(setChoice({ domain: "acme.com", provider: 0 })).rejects.toThrow("upsert failed");
    expect(bumpResyncNonce).not.toHaveBeenCalled();
    expect(invalidateKnownCompanyLogoShaCache).not.toHaveBeenCalled();
  });
});

describe("clearCompanyLogoChoice", () => {
  it("deletes only the caller's pick for that domain", async () => {
    const res = await clearChoice({ domain: "ACME.com" });

    expect(res).toEqual({ ok: true });
    expect(rls.calls.deletes[0]).toMatchObject({
      table: "company_logo_choices",
      filters: [
        { op: "eq", col: "user_id", value: TEST_USER },
        { op: "eq", col: "domain", value: "acme.com" },
      ],
    });
  });

  it("rejects a malformed domain", async () => {
    await expect(clearChoice({ domain: "not a domain" })).rejects.toThrow();
    expect(rls.calls.deletes).toEqual([]);
  });

  it("throws on a delete failure without running the fan-out", async () => {
    rls.onDelete("company_logo_choices", () => ({ message: "delete failed" }));
    await expect(clearChoice({ domain: "acme.com" })).rejects.toThrow("delete failed");
    expect(invalidateKnownCompanyLogoShaCache).not.toHaveBeenCalled();
  });
});

describe.each([
  ["setCompanyLogoChoice", (d: string) => setChoice({ domain: d, provider: 0 })],
  ["clearCompanyLogoChoice", (d: string) => clearChoice({ domain: d })],
])("%s fan-out", (_name, run) => {
  it("bumps the CardDAV resync nonce and drops the known-logo SHA cache", async () => {
    await run("acme.com");
    // The nonce is bumped on the SERVICE-ROLE client (the RLS client cannot
    // see the settings row), for this user only.
    expect(bumpResyncNonce).toHaveBeenCalledWith(expect.anything(), TEST_USER);
    expect(invalidateKnownCompanyLogoShaCache).toHaveBeenCalledWith(TEST_USER);
  });

  it("marks every contact of the domain's company photo-dirty", async () => {
    seedLinkedCompany();
    await run("acme.com");
    // c3 belongs to a different company and must be left alone.
    expect(markGooglePhotoDirtyMany).toHaveBeenCalledWith(TEST_USER, ["c1", "c2"]);
  });

  it("skips the photo-dirty pass when the domain maps to no company", async () => {
    await run("unlinked.com");
    expect(markGooglePhotoDirtyMany).not.toHaveBeenCalled();
  });

  it("skips it when the company has no contacts", async () => {
    admin.seedRaw("company_domains", [
      { user_id: TEST_USER, domain: "acme.com", company_id: "co-empty" },
    ]);
    await run("acme.com");
    expect(markGooglePhotoDirtyMany).not.toHaveBeenCalled();
  });

  it("still succeeds when the resync bump fails", async () => {
    bumpResyncNonce.mockRejectedValue(new Error("nonce boom"));
    await expect(run("acme.com")).resolves.toEqual({ ok: true });
    // The later steps must not be skipped by the earlier failure.
    expect(invalidateKnownCompanyLogoShaCache).toHaveBeenCalledWith(TEST_USER);
  });

  it("still succeeds when the photo-dirty marking fails", async () => {
    seedLinkedCompany();
    markGooglePhotoDirtyMany.mockRejectedValue(new Error("dirty boom"));
    await expect(run("acme.com")).resolves.toEqual({ ok: true });
    expect(invalidateKnownCompanyLogoShaCache).toHaveBeenCalledWith(TEST_USER);
  });

  it("scopes the fan-out lookups to the caller", async () => {
    seedLinkedCompany();
    await run("acme.com");
    expect(admin.calls.selects[0]).toMatchObject({
      table: "company_domains",
      filters: [
        { op: "eq", col: "user_id", value: TEST_USER },
        { op: "eq", col: "domain", value: "acme.com" },
      ],
    });
    expect(admin.calls.selects[1]).toMatchObject({
      table: "contacts",
      filters: [
        { op: "eq", col: "user_id", value: TEST_USER },
        { op: "eq", col: "company_id", value: "co-1" },
      ],
    });
  });
});
