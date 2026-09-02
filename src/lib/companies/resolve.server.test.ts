// src/lib/companies/resolve.server.ts — the shared company resolver used by
// contact CRUD, the Google Contacts pull and the CardDAV PUT handler. Not a
// server fn: the caller hands it a client and a user id, so the isolation
// contract here is that every read and the insert carry that user id.

import { describe, it, expect, beforeEach } from "vitest";
import { makeSupabaseFake, writeCount, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { findOrCreateCompanyByName, resolveContactCompany } from "./resolve.server";
import type { ResolveCtx } from "./resolve.server";

const fake = makeSupabaseFake({ applyWrites: true });

const USER = "user-1";
const OTHER = "user-2";
const COMPANY = "aaaaaaaa-1111-4111-8111-111111111111";
const TARGET = "bbbbbbbb-2222-4222-8222-222222222222";

/** The resolver only calls `.from(...)` on whatever client it is handed. */
const ctx = { supabase: fake.supabaseAdmin, userId: USER } as unknown as ResolveCtx;

beforeEach(() => {
  fake.reset();
});

describe("findOrCreateCompanyByName", () => {
  it("returns null without touching the database for a blank name", async () => {
    expect(await findOrCreateCompanyByName(ctx, "   ")).toBeNull();
    expect(fake.calls.selects).toHaveLength(0);
    expect(writeCount(fake)).toBe(0);
  });

  it("matches an existing company on its normalized name key", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme Inc", name_key: "acme" }]);

    expect(await findOrCreateCompanyByName(ctx, "  ACME Inc.  ")).toStrictEqual({
      id: COMPANY,
      user_id: USER,
      name: "Acme Inc",
      name_key: "acme",
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("never matches another user's company and mints one instead", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: OTHER, name: "Acme", name_key: "acme" }]);
    fake.onInsert("companies", () => ({ data: [{ id: TARGET, name: "Acme" }] }));

    const res = await findOrCreateCompanyByName(ctx, "Acme");

    expect(res).toStrictEqual({ id: TARGET, name: "Acme" });
    expect(writesTo(fake, "inserts", "companies")[0]!.payload).toStrictEqual({
      user_id: USER,
      name: "Acme",
      name_key: "acme",
    });
  });

  it("routes a name a previous merge aliased to the surviving company", async () => {
    fake.seedRaw("company_name_aliases", [
      {
        user_id: USER,
        name_key: "acme",
        company_id: TARGET,
        source_name: "Acme",
        companies: { id: TARGET, name: "Acme Holdings" },
      },
    ]);

    expect(await findOrCreateCompanyByName(ctx, "Acme")).toStrictEqual({
      id: TARGET,
      name: "Acme Holdings",
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("falls back to a re-select when a parallel insert wins the race", async () => {
    fake.onInsert("companies", () => ({ message: "duplicate key value" }));
    let firstRead = true;
    fake.onSelect("companies", () => {
      if (firstRead) {
        firstRead = false;
        return { data: [] };
      }
      return { data: [{ id: COMPANY, user_id: USER, name: "Acme", name_key: "acme" }] };
    });

    expect(await findOrCreateCompanyByName(ctx, "Acme")).toStrictEqual({
      id: COMPANY,
      user_id: USER,
      name: "Acme",
      name_key: "acme",
    });
  });

  it("rethrows the insert error when the re-select also finds nothing", async () => {
    fake.onInsert("companies", () => ({ message: "insert blocked" }));

    await expect(findOrCreateCompanyByName(ctx, "Acme")).rejects.toThrow("insert blocked");
  });

  it("propagates a read failure instead of creating a duplicate", async () => {
    fake.onSelect("companies", () => ({ message: "select blocked" }));

    await expect(findOrCreateCompanyByName(ctx, "Acme")).rejects.toThrow("select blocked");
    expect(writeCount(fake)).toBe(0);
  });

  it("memoizes by name key so one batch import resolves each name once", async () => {
    fake.seed("companies", [{ id: COMPANY, user_id: USER, name: "Acme", name_key: "acme" }]);
    const cache = new Map<string, { id: string; name: string } | null>();

    await findOrCreateCompanyByName(ctx, "Acme", cache);
    const readsAfterFirst = fake.calls.selects.length;
    await findOrCreateCompanyByName(ctx, "ACME Inc.", cache);

    expect(fake.calls.selects).toHaveLength(readsAfterFirst);
    expect([...cache.keys()]).toStrictEqual(["acme"]);
  });
});

describe("resolveContactCompany", () => {
  it("treats null, undefined and whitespace as 'no company'", async () => {
    for (const input of [null, undefined, "   "]) {
      expect(await resolveContactCompany(ctx, input)).toStrictEqual({
        companyId: null,
        canonicalName: null,
      });
    }
    expect(fake.calls.selects).toHaveLength(0);
  });

  it("returns the canonical name of the resolved company, not the text it was given", async () => {
    fake.seed("companies", [
      { id: COMPANY, user_id: USER, name: "Acme Holdings", name_key: "acme" },
    ]);

    expect(await resolveContactCompany(ctx, "  acme inc.  ")).toStrictEqual({
      companyId: COMPANY,
      canonicalName: "Acme Holdings",
    });
  });
});
