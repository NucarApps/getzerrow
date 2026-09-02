// Unit tests for the auto-record toggles
// (src/lib/meetings/auto-record.functions.ts). These write through
// `context.supabase` (the RLS client) with an id-only filter, so RLS is the
// entire tenant boundary here — see the `// RLS-RELIANCE:` note.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeSupabaseFake, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { TEST_USER } from "@/lib/__fixtures__/server-fn-stub";
import { callWithRlsClient } from "@/lib/__fixtures__/rls-server-fn";

const fake = makeSupabaseFake({ applyWrites: true });

vi.mock("@tanstack/react-start", async () => {
  const { createServerFn } = await import("@/lib/__fixtures__/server-fn-stub");
  return { createServerFn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: { __passthrough: true },
}));

import { getAutoRecordStatus, setAutoRecord, setRecordDeclined } from "./auto-record.functions";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const call = <F extends (args: never) => Promise<unknown>>(fn: F) =>
  callWithRlsClient(fn, { fake });

beforeEach(() => {
  fake.reset();
});

describe("getAutoRecordStatus", () => {
  it("reports all three flags off for an account the caller cannot see", async () => {
    await expect(
      call(getAutoRecordStatus)({ data: { accountId: ACCOUNT } }),
    ).resolves.toStrictEqual({ enabled: false, calendarAccess: false, recordDeclined: false });
    expect(writeCount(fake)).toBe(0);
  });

  it("reports the stored flags for the caller's own account", async () => {
    fake.seed("gmail_accounts", [
      {
        id: ACCOUNT,
        user_id: TEST_USER,
        auto_record_meetings: true,
        calendar_access: true,
        record_declined_meetings: false,
      },
    ]);

    await expect(
      call(getAutoRecordStatus)({ data: { accountId: ACCOUNT } }),
    ).resolves.toStrictEqual({ enabled: true, calendarAccess: true, recordDeclined: false });
  });

  it("surfaces a failing read", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "read denied" }));

    await expect(call(getAutoRecordStatus)({ data: { accountId: ACCOUNT } })).rejects.toThrow(
      "read denied",
    );
  });
});

describe("setAutoRecord / setRecordDeclined", () => {
  // RLS-RELIANCE: neither handler reads the account first, and the UPDATE is
  // filtered on id alone — unlike calendar.functions.ts, which does an
  // explicit ownership read on the service-role client. RLS on
  // context.supabase is the only boundary; asserted here so the filter set
  // can never silently lose the user scope RLS supplies.
  it("filters each update by id only", async () => {
    await expect(
      call(setAutoRecord)({ data: { accountId: ACCOUNT, enabled: true } }),
    ).resolves.toStrictEqual({ enabled: true });
    await expect(
      call(setRecordDeclined)({ data: { accountId: ACCOUNT, enabled: false } }),
    ).resolves.toStrictEqual({ enabled: false });

    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "gmail_accounts",
        { auto_record_meetings: true },
        [{ op: "eq", col: "id", value: ACCOUNT, extra: undefined }],
      ],
      [
        "gmail_accounts",
        { record_declined_meetings: false },
        [{ op: "eq", col: "id", value: ACCOUNT, extra: undefined }],
      ],
    ]);
  });

  it("surfaces a rejected update on either toggle", async () => {
    fake.onUpdate("gmail_accounts", () => ({ message: "update denied" }));

    await expect(
      call(setAutoRecord)({ data: { accountId: ACCOUNT, enabled: true } }),
    ).rejects.toThrow("update denied");
    await expect(
      call(setRecordDeclined)({ data: { accountId: ACCOUNT, enabled: true } }),
    ).rejects.toThrow("update denied");
  });
});
