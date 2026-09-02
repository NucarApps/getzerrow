// src/lib/companies/converge.ts — the best-effort fan-out every company↔contact
// mutation runs afterwards. Its whole contract is that neither step can fail
// the mutation that triggered it, and that the second step runs even when the
// first threw.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";

const syncCompanyRuleMemberships = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>());
vi.mock("@/lib/contacts/group-rules.functions", () => ({
  syncCompanyRuleMemberships: (...args: unknown[]) => syncCompanyRuleMemberships(...args),
}));
const reconcileAutoParentsForContacts = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<void>>(),
);
vi.mock("@/lib/contacts/auto-company-subgroups.functions", () => ({
  reconcileAutoParentsForContacts: (...args: unknown[]) => reconcileAutoParentsForContacts(...args),
}));

import { convergeCompanyMemberships } from "./converge";

const fake = makeSupabaseFake();
const client = fake.supabaseAdmin as unknown as SupabaseClient<Database>;
const USER = "user-1";
const COMPANY = "aaaaaaaa-1111-4111-8111-111111111111";

beforeEach(() => {
  fake.reset();
  syncCompanyRuleMemberships.mockResolvedValue(undefined);
  reconcileAutoParentsForContacts.mockResolvedValue(undefined);
});

describe("convergeCompanyMemberships", () => {
  it("forwards the company ids and defaults the resync bump to on", async () => {
    await convergeCompanyMemberships(client, USER, {
      companyIds: [COMPANY],
      contactIds: ["k1", "k2"],
    });

    expect(syncCompanyRuleMemberships).toHaveBeenCalledWith(client, USER, {
      companyIds: [COMPANY],
      contactIds: ["k1", "k2"],
      bumpResync: true,
    });
    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(client, USER, ["k1", "k2"]);
  });

  it("omits companyIds entirely when the caller has none", async () => {
    await convergeCompanyMemberships(client, USER, { contactIds: ["k1"], bumpResync: false });

    expect(syncCompanyRuleMemberships).toHaveBeenCalledWith(client, USER, {
      contactIds: ["k1"],
      bumpResync: false,
    });
  });

  it("still reconciles the subgroups after a rule-membership failure", async () => {
    syncCompanyRuleMemberships.mockRejectedValue(new Error("membership boom"));

    await expect(
      convergeCompanyMemberships(client, USER, { contactIds: ["k1"] }),
    ).resolves.toBeUndefined();

    expect(reconcileAutoParentsForContacts).toHaveBeenCalledWith(client, USER, ["k1"]);
  });

  it("swallows a subgroup-reconcile failure", async () => {
    reconcileAutoParentsForContacts.mockRejectedValue(new Error("reconcile boom"));

    await expect(
      convergeCompanyMemberships(client, USER, { contactIds: ["k1"] }),
    ).resolves.toBeUndefined();
  });
});
