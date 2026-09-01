// Unit tests for the row-ownership guards (assertOwnsContact /
// assertOwnsCompany) that server functions use to check a client-supplied
// id actually belongs to the calling user before acting on it. Pins the
// three-way outcome: owner passes silently, a row owned by someone else (or
// missing entirely) throws "not found", and a DB error surfaces the
// Postgres message rather than being flattened into "not found" — so an RLS
// or connectivity failure isn't misreported as a missing row.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

// makeSupabaseFake's select path never returns an error (maybeSingle always
// resolves { error: null }), so the DB-error test below is driven through
// this local switch instead of the shared fixture, without modifying it.
let selectError: { message: string } | null = null;

// Property accesses are deferred into method bodies so the hoisted factory
// never touches `fake` before its initializer runs.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (selectError) {
        const err = selectError;
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: err }),
              }),
            }),
          }),
        };
      }
      return fake.supabaseAdmin.from(table);
    },
  },
}));

import { assertOwnsContact, assertOwnsCompany } from "./ownership";

const USER = "user-1";
const OTHER_USER = "user-2";

beforeEach(() => {
  fake.reset();
  selectError = null;
});

describe("assertOwnsContact", () => {
  it("resolves silently when the contact belongs to the user", async () => {
    fake.seed("contacts", [{ id: "contact-1", user_id: USER }]);
    await expect(assertOwnsContact(USER, "contact-1")).resolves.toBeUndefined();
  });

  it("throws 'not found' when the contact belongs to a different user", async () => {
    fake.seed("contacts", [{ id: "contact-1", user_id: OTHER_USER }]);
    await expect(assertOwnsContact(USER, "contact-1")).rejects.toThrow("Contact not found");
  });

  it("throws 'not found' when the contact row does not exist at all", async () => {
    fake.seed("contacts", []);
    await expect(assertOwnsContact(USER, "missing-id")).rejects.toThrow("Contact not found");
  });

  it("surfaces the underlying Postgres error instead of reporting 'not found'", async () => {
    selectError = { message: "connection reset" };
    await expect(assertOwnsContact(USER, "contact-1")).rejects.toThrow(
      "Contact lookup failed: connection reset",
    );
  });
});

describe("assertOwnsCompany", () => {
  it("resolves silently when the company belongs to the user", async () => {
    fake.seed("companies", [{ id: "company-1", user_id: USER }]);
    await expect(assertOwnsCompany(USER, "company-1")).resolves.toBeUndefined();
  });

  it("throws 'not found' when the company belongs to a different user", async () => {
    fake.seed("companies", [{ id: "company-1", user_id: OTHER_USER }]);
    await expect(assertOwnsCompany(USER, "company-1")).rejects.toThrow("Company not found");
  });
});
