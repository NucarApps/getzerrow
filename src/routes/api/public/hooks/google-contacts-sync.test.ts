// Contract for the Google Contacts sync tick: which enabled accounts are due,
// the per-account cadence that decides it, and the tally its caller reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron } from "../__fixtures__/route-harness";
import { Route } from "./google-contacts-sync";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const runGoogleContactsSync = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/google-contacts/reconcile.server").runGoogleContactsSync>(),
);
vi.mock("@/lib/google-contacts/reconcile.server", () => ({ runGoogleContactsSync }));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const MINUTE = 60_000;
const PATH = "hooks/google-contacts-sync";

type SyncBody = {
  ok: boolean;
  runId?: string;
  total?: number;
  ranOk?: number;
  failed?: number;
  skipped?: number;
  errors?: Array<{ accountId: string; error: string }>;
  error?: string;
};

function syncState(over: Record<string, unknown> = {}) {
  return {
    user_id: USER_ID,
    gmail_account_id: ACCOUNT_ID,
    enabled: true,
    sync_interval_minutes: 15,
    last_incremental_at: new Date(NOW - 60 * MINUTE).toISOString(),
    locked_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  runGoogleContactsSync.mockResolvedValue({ ok: true, pull: 2, push: 1 });
});

describe("selection", () => {
  it("syncs a due, enabled account and reports the tally", async () => {
    fake.seed("google_sync_state", [syncState()]);

    const { status, body } = await callCron<SyncBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      runId: RUN_ID,
      total: 1,
      ranOk: 1,
      failed: 0,
      skipped: 0,
      errors: [],
    });
    expect(runGoogleContactsSync).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID);
  });

  it("asks only for enabled accounts", async () => {
    fake.seed("google_sync_state", [syncState(), syncState({ enabled: false })]);

    await callCron<SyncBody>(Route, PATH);

    expect(fake.calls.selects[0]?.filters).toStrictEqual([
      { op: "eq", col: "enabled", value: true, extra: undefined },
    ]);
    expect(runGoogleContactsSync).toHaveBeenCalledTimes(1);
  });

  it("skips an account that is not yet due for its cadence", async () => {
    fake.seed("google_sync_state", [
      syncState({ last_incremental_at: new Date(NOW - 5 * MINUTE).toISOString() }),
    ]);

    const { body } = await callCron<SyncBody>(Route, PATH);

    expect(runGoogleContactsSync).not.toHaveBeenCalled();
    expect(body).toMatchObject({ total: 1, ranOk: 0, skipped: 1 });
  });

  it("runs 30 seconds early so clock drift cannot make a due tick miss", async () => {
    // 15-minute cadence, last run 14m40s ago: inside the interval but inside
    // the grace, so it is due.
    fake.seed("google_sync_state", [
      syncState({ last_incremental_at: new Date(NOW - (15 * MINUTE - 20_000)).toISOString() }),
    ]);

    const { body } = await callCron<SyncBody>(Route, PATH);

    expect(body).toMatchObject({ ranOk: 1, skipped: 0 });
  });

  it("always runs an account that has never synced", async () => {
    fake.seed("google_sync_state", [syncState({ last_incremental_at: null })]);

    const { body } = await callCron<SyncBody>(Route, PATH);

    expect(body).toMatchObject({ ranOk: 1, skipped: 0 });
  });

  it("defaults a missing cadence to 15 minutes", async () => {
    fake.seed("google_sync_state", [
      syncState({
        sync_interval_minutes: null,
        last_incremental_at: new Date(NOW - 5 * MINUTE).toISOString(),
      }),
    ]);

    const { body } = await callCron<SyncBody>(Route, PATH);

    expect(body).toMatchObject({ skipped: 1, ranOk: 0 });
  });
});

describe("failure handling", () => {
  it("returns 500 with the message when the sync-state query fails", async () => {
    fake.onSelect("google_sync_state", () => ({ message: "permission denied" }));

    const { status, body } = await callCron<SyncBody>(Route, PATH);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ ok: false, error: "permission denied" });
    expect(runGoogleContactsSync).not.toHaveBeenCalled();
  });

  it("records a reported sync failure and carries on to the next account", async () => {
    fake.seed("google_sync_state", [
      syncState(),
      syncState({ gmail_account_id: "33333333-3333-4333-8333-333333333333" }),
    ]);
    runGoogleContactsSync
      .mockResolvedValueOnce({ ok: false, error: "missing_contacts_scope" })
      .mockResolvedValueOnce({ ok: true });

    const { status, body } = await callCron<SyncBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      total: 2,
      ranOk: 1,
      failed: 1,
      errors: [{ accountId: ACCOUNT_ID, error: "missing_contacts_scope" }],
    });
  });

  it("labels a reported failure with no message as unknown", async () => {
    fake.seed("google_sync_state", [syncState()]);
    runGoogleContactsSync.mockResolvedValue({ ok: false });

    const { body } = await callCron<SyncBody>(Route, PATH);

    expect(body.errors).toStrictEqual([{ accountId: ACCOUNT_ID, error: "unknown" }]);
  });

  it("catches a thrown sync and keeps the tick going", async () => {
    fake.seed("google_sync_state", [
      syncState(),
      syncState({ gmail_account_id: "33333333-3333-4333-8333-333333333333" }),
    ]);
    runGoogleContactsSync
      .mockRejectedValueOnce(new Error("people API 503"))
      .mockResolvedValueOnce({ ok: true });

    const { status, body } = await callCron<SyncBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      total: 2,
      ranOk: 1,
      failed: 1,
      errors: [{ accountId: ACCOUNT_ID, error: "people API 503" }],
    });
  });

  it("writes nothing itself — all persistence belongs to the sync it delegates to", async () => {
    fake.seed("google_sync_state", [syncState()]);

    await callCron<SyncBody>(Route, PATH);

    expect(writeCount(fake)).toBe(0);
  });
});
