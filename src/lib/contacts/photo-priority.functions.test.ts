// Photo-priority settings at the three tiers (photo-priority.functions.ts).
// Contracts protected:
//
//   * the per-company and per-contact writes filter by (id, user_id), so a
//     foreign id changes nothing,
//   * every write nudges the two sync channels: the affected contacts are
//     marked photo-dirty for the Google push, and the CardDAV resync_nonce
//     is bumped (read-then-upsert) so iPhones re-fetch,
//   * the global default upserts on user_id and clears every photo_etag,
//   * a failing write surfaces before any sync nudge happens.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  writesTo,
} from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { makeContactRow } from "./__fixtures__/rows";

const fake = makeSupabaseFake();
const rls = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const bumpResyncNonce = vi.fn(async () => {});
vi.mock("@/lib/carddav/settings.functions", () => ({
  bumpResyncNonce: (...a: unknown[]) => bumpResyncNonce(...(a as [])),
}));

const markGooglePhotoDirtyMany = vi.fn(async () => {});
vi.mock("@/lib/google-contacts/mark-dirty.server", () => ({
  markGooglePhotoDirtyMany: (...a: unknown[]) => markGooglePhotoDirtyMany(...(a as [])),
}));

import {
  setGlobalPhotoPriority,
  setCompanyPhotoPriority,
  setContactPhotoPriority,
  getPhotoPrioritySettings,
} from "./photo-priority.functions";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const VICTIM = "victim-user-2";
const ATTACKER = "attacker-user-9";

type CallArgs = { data?: unknown; context?: Record<string, unknown> };
function call(fn: unknown, args: CallArgs): Promise<never> {
  return (fn as (a: CallArgs) => Promise<never>)(args);
}
const asUser = { supabase: rls.supabaseAdmin };
const asAttacker = { supabase: rls.supabaseAdmin, userId: ATTACKER };

beforeEach(() => {
  fake.reset();
  rls.reset();
  bumpResyncNonce.mockClear();
  markGooglePhotoDirtyMany.mockClear();
});

describe("setContactPhotoPriority", () => {
  it("another tenant's contact keeps its priority and is never marked dirty", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: VICTIM, photo_priority: "company_first" }),
    ]);
    await call(setContactPhotoPriority, {
      data: { contactId: CONTACT_ID, priority: "personal_only" },
      context: asAttacker,
    });
    // The UPDATE carries the user_id predicate, so it matches no row.
    expect(rls.rows("contacts")[0]).toMatchObject({ photo_priority: "company_first" });
    expect(rls.calls.updates[0]!.filters).toStrictEqual([
      { op: "eq", col: "id", value: CONTACT_ID, extra: undefined },
      { op: "eq", col: "user_id", value: ATTACKER, extra: undefined },
    ]);
    // The dirty-marking and nonce bump run for the id regardless — they are
    // no-ops against a row the caller cannot see, and cost one write each.
    expect(markGooglePhotoDirtyMany).toHaveBeenCalledWith(ATTACKER, [CONTACT_ID]);
  });

  it("writes the priority, stamps updated_at, marks the photo dirty and bumps the nonce", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    rls.seed("contacts", [makeContactRow({ id: CONTACT_ID, user_id: TEST_USER })]);
    fake.seed("carddav_settings", [{ user_id: TEST_USER, resync_nonce: 7 }]);

    const res = await call(setContactPhotoPriority, {
      data: { contactId: CONTACT_ID, priority: "personal_first" },
      context: asUser,
    });
    expect(res).toEqual({ ok: true });
    expect(rls.calls.updates[0]!.payload).toStrictEqual({
      photo_priority: "personal_first",
      updated_at: "2026-03-01T12:00:00.000Z",
    });
    expect(markGooglePhotoDirtyMany).toHaveBeenCalledWith(TEST_USER, [CONTACT_ID]);
    // The CardDAV nonce is read then written back incremented.
    expect(writesTo(fake, "upserts", "carddav_settings")[0]).toMatchObject({
      payload: { user_id: TEST_USER, resync_nonce: 8 },
      options: { onConflict: "user_id" },
    });
    vi.useRealTimers();
  });

  it("a null priority clears the per-contact override", async () => {
    rls.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, photo_priority: "personal_only" }),
    ]);
    await call(setContactPhotoPriority, {
      data: { contactId: CONTACT_ID, priority: null },
      context: asUser,
    });
    expect(rls.rows("contacts")[0]).toMatchObject({ photo_priority: null });
  });

  it("a failing update surfaces before any sync nudge", async () => {
    rls.onUpdate("contacts", () => ({ message: "invalid input value for enum" }));
    await expect(
      call(setContactPhotoPriority, {
        data: { contactId: CONTACT_ID, priority: "personal_only" },
        context: asUser,
      }),
    ).rejects.toThrow("invalid input value for enum");
    expect(markGooglePhotoDirtyMany).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("zod rejects an unknown priority and a non-uuid id", async () => {
    await expect(
      setContactPhotoPriority({ data: { contactId: CONTACT_ID, priority: "shiny" } }),
    ).rejects.toThrow();
    await expect(
      setContactPhotoPriority({ data: { contactId: "nope", priority: null } }),
    ).rejects.toThrow();
    expect(writeCount(rls)).toBe(0);
  });
});

describe("setCompanyPhotoPriority", () => {
  it("another tenant's company keeps its priority and none of its contacts are touched", async () => {
    rls.seed("companies", [
      { id: COMPANY_ID, user_id: VICTIM, name: "Victim Co", photo_priority: "company_first" },
    ]);
    fake.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: VICTIM, company_id: COMPANY_ID }),
    ]);
    const res = (await call(setCompanyPhotoPriority, {
      data: { companyId: COMPANY_ID, priority: "personal_only" },
      context: asAttacker,
    })) as unknown as { contactsAffected: number };
    expect(rls.rows("companies")[0]).toMatchObject({ photo_priority: "company_first" });
    expect(res.contactsAffected).toBe(0);
    expect(markGooglePhotoDirtyMany).not.toHaveBeenCalled();
  });

  it("marks every contact of the company dirty and reports the count", async () => {
    rls.seed("companies", [{ id: COMPANY_ID, user_id: TEST_USER, name: "Acme" }]);
    fake.seed("contacts", [
      makeContactRow({ id: CONTACT_ID, user_id: TEST_USER, company_id: COMPANY_ID }),
      makeContactRow({ id: "c2", user_id: TEST_USER, company_id: COMPANY_ID }),
      makeContactRow({ id: "elsewhere", user_id: TEST_USER, company_id: "other-company" }),
      makeContactRow({ id: "foreign", user_id: VICTIM, company_id: COMPANY_ID }),
    ]);
    const res = (await call(setCompanyPhotoPriority, {
      data: { companyId: COMPANY_ID, priority: "company_first" },
      context: asUser,
    })) as unknown as { ok: boolean; contactsAffected: number };
    expect(res).toEqual({ ok: true, contactsAffected: 2 });
    expect(markGooglePhotoDirtyMany).toHaveBeenCalledWith(TEST_USER, [CONTACT_ID, "c2"]);
    expect(rls.calls.updates[0]!.payload).toStrictEqual({ photo_priority: "company_first" });
  });

  it("a failing update surfaces before any sync nudge", async () => {
    rls.onUpdate("companies", () => ({ message: "permission denied" }));
    await expect(
      call(setCompanyPhotoPriority, {
        data: { companyId: COMPANY_ID, priority: null },
        context: asUser,
      }),
    ).rejects.toThrow("permission denied");
    expect(markGooglePhotoDirtyMany).not.toHaveBeenCalled();
  });
});

describe("setGlobalPhotoPriority", () => {
  it("upserts the account default, clears every photo_etag and bumps the nonce", async () => {
    const res = await call(setGlobalPhotoPriority, {
      data: { priority: "personal_only" },
      context: asUser,
    });
    expect(res).toEqual({ ok: true });
    expect(rls.calls.upserts[0]).toMatchObject({
      table: "carddav_settings",
      payload: { user_id: TEST_USER, photo_priority: "personal_only" },
      options: { onConflict: "user_id" },
    });
    expect(bumpResyncNonce).toHaveBeenCalledWith(rls.supabaseAdmin, TEST_USER);
    const reset = writesTo(fake, "updates", "google_contact_links")[0]!;
    expect(reset.payload).toStrictEqual({ photo_etag: null, photo_push_attempts: 0 });
    expect(reset.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: TEST_USER, extra: undefined },
    ]);
  });

  it("a failing upsert surfaces before any sync nudge", async () => {
    rls.onUpsert("carddav_settings", () => ({ message: "permission denied" }));
    await expect(
      call(setGlobalPhotoPriority, { data: { priority: "personal_only" }, context: asUser }),
    ).rejects.toThrow("permission denied");
    expect(bumpResyncNonce).not.toHaveBeenCalled();
    expect(writeCount(fake)).toBe(0);
  });

  it("zod rejects an unknown priority", async () => {
    await expect(setGlobalPhotoPriority({ data: { priority: "shiny" } })).rejects.toThrow();
    expect(writeCount(rls)).toBe(0);
  });
});

describe("getPhotoPrioritySettings", () => {
  it("returns the stored default", async () => {
    rls.seed("carddav_settings", [{ user_id: TEST_USER, photo_priority: "personal_first" }]);
    const res = await call(getPhotoPrioritySettings, { data: {}, context: asUser });
    expect(res).toEqual({ global: "personal_first" });
  });

  it("falls back to company_first when the account has no row", async () => {
    const res = await call(getPhotoPrioritySettings, { data: {}, context: asUser });
    expect(res).toEqual({ global: "company_first" });
  });
});
