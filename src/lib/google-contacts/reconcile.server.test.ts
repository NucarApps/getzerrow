// Tests for the Google Contacts sync orchestrator (runGoogleContactsSync)
// and the scope predicate. pull/push/state/progress are stubbed; the REAL
// people-client module is kept so PeopleApiError (and its isMissingScope
// taxonomy) behaves exactly as in production.
//
// Contracts protected here:
//   - the lease: a fresh lock skips the run, a stale one is reclaimed, and
//     EVERY exit path — success, needs_reconnect short-circuit, thrown
//     errors — clears progress and releases the lock;
//   - pull_only mode must never call the push side;
//   - sync-token persistence: a null token from pull preserves the previous
//     cursor instead of erasing it (losing it forces a full resync);
//   - error taxonomy: NeedsReconnectError → "needs_reconnect", missing
//     People scope → "missing_contacts_scope", anything else truncated.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeSupabaseFake } from "@/lib/__fixtures__/supabase-fake";
import type { SyncState } from "./state.server";

const fake = makeSupabaseFake();
const pullMock = vi.fn();
const pushMock = vi.fn();
const ensureSyncStateMock = vi.fn();
const updateSyncStateMock = vi.fn(async (_id: string, _patch: Record<string, unknown>) => {});
const loadSyncStateMock = vi.fn();
const progressSetMock = vi.fn(async () => {});
const progressClearMock = vi.fn(async () => {});
const logInfoMock = vi.fn();
const logErrorMock = vi.fn();

// CRITICAL: factories must not touch module-level consts at factory time
// (vi.mock hoisting) — every property access is deferred into method bodies.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => fake.supabaseAdmin.from(table),
    rpc: (fn: string, args: Record<string, unknown>) => fake.supabaseAdmin.rpc(fn, args),
  },
}));
vi.mock("@/lib/google-oauth.server", () => {
  class NeedsReconnectError extends Error {
    constructor(accountId = "acct", reason = "needs_reconnect") {
      super(`account ${accountId}: ${reason}`);
      this.name = "NeedsReconnectError";
    }
  }
  return { NeedsReconnectError, getAccessToken: async () => "test-token" };
});
vi.mock("./pull.server", () => ({
  pullFromGoogle: (...args: unknown[]) => pullMock(...args),
}));
vi.mock("./push.server", () => ({
  pushToGoogle: (...args: unknown[]) => pushMock(...args),
}));
vi.mock("./state.server", () => ({
  ensureSyncState: (...args: unknown[]) => ensureSyncStateMock(...args),
  updateSyncState: (id: string, patch: Record<string, unknown>) => updateSyncStateMock(id, patch),
  loadSyncState: (...args: unknown[]) => loadSyncStateMock(...args),
}));
vi.mock("./progress.server", () => ({
  createProgressReporter: () => ({
    set: (...args: unknown[]) => progressSetMock(...(args as [])),
    increment: async () => {},
    clear: () => progressClearMock(),
  }),
}));
vi.mock("@/lib/log.server", () => ({
  logInfo: (...args: unknown[]) => logInfoMock(...args),
  logError: (...args: unknown[]) => logErrorMock(...args),
}));

import { runGoogleContactsSync, accountHasContactsScope } from "./reconcile.server";
import { CONTACTS_SCOPE, PeopleApiError } from "./people-client.server";
import { NeedsReconnectError } from "@/lib/google-oauth.server";

const USER = "user-1";
const ACC = "acct-1";
const STATE_ID = "state-1";

function baseState(over: Partial<SyncState> = {}): SyncState {
  return {
    id: STATE_ID,
    user_id: USER,
    gmail_account_id: ACC,
    enabled: true,
    sync_mode: "two_way",
    people_sync_token: "prev-people",
    groups_sync_token: "prev-groups",
    last_full_sync_at: null,
    last_incremental_at: null,
    last_error: null,
    last_pull_count: 0,
    last_push_count: 0,
    pending_bump: false,
    locked_at: null,
    progress_step: null,
    progress_processed: 0,
    progress_total: 0,
    progress_updated_at: null,
    last_pull_created: 0,
    last_pull_updated: 0,
    last_pull_skipped_no_email: 0,
    last_pull_merged: 0,
    last_pull_failed: 0,
    sync_interval_minutes: 30,
    ...over,
  };
}

function pullResult(over: Record<string, unknown> = {}) {
  return {
    peopleSyncToken: "new-people",
    groupsSyncToken: "new-groups",
    usedFullResync: false,
    pulled: 3,
    breakdown: {
      created: 1,
      updated: 1,
      skipped_no_email: 0,
      merged_duplicate_email: 0,
      merged_by_phone: 0,
      failed: 1,
    },
    ...over,
  };
}

/** All updateSyncState patches recorded so far, in call order. */
function patches(): Array<Record<string, unknown>> {
  return updateSyncStateMock.mock.calls.map((c) => c[1] as Record<string, unknown>);
}

beforeEach(() => {
  fake.reset();
  vi.clearAllMocks();
  fake.seed("gmail_accounts", [{ id: ACC, needs_reconnect: false }]);
  fake.seed("google_contact_links", []);
  ensureSyncStateMock.mockResolvedValue(baseState());
  pullMock.mockResolvedValue(pullResult());
  pushMock.mockResolvedValue({
    contactsPushed: 2,
    groupsPushed: 1,
    membershipsPushed: 1,
    tombstonesApplied: 0,
  });
});

describe("accountHasContactsScope", () => {
  it("grants only on the exact People scope token, never a near-miss", () => {
    expect(accountHasContactsScope(`openid ${CONTACTS_SCOPE} email`)).toBe(true);
    // A scope string that merely CONTAINS the token as a prefix of a longer
    // scope must not grant (readonly is a different permission).
    expect(accountHasContactsScope(`${CONTACTS_SCOPE}.readonly`)).toBe(false);
    expect(accountHasContactsScope("https://www.googleapis.com/auth/gmail.modify")).toBe(false);
    expect(accountHasContactsScope(null)).toBe(false);
    expect(accountHasContactsScope("")).toBe(false);
  });
});

describe("runGoogleContactsSync gating", () => {
  it("returns sync_disabled without locking when the mode is off", async () => {
    ensureSyncStateMock.mockResolvedValue(baseState({ enabled: false, sync_mode: "off" }));
    const res = await runGoogleContactsSync(USER, ACC);
    expect(res).toEqual({ ok: false, error: "sync_disabled" });
    expect(updateSyncStateMock).not.toHaveBeenCalled();
    expect(pullMock).not.toHaveBeenCalled();
  });

  it("skips the run while another worker holds a fresh lease", async () => {
    ensureSyncStateMock.mockResolvedValue(
      baseState({ locked_at: new Date(Date.now() - 1_000).toISOString() }),
    );
    const res = await runGoogleContactsSync(USER, ACC);
    expect(res).toEqual({ ok: false, error: "locked" });
    expect(pullMock).not.toHaveBeenCalled();
    // Not even a lock write — the other worker's lease is respected.
    expect(updateSyncStateMock).not.toHaveBeenCalled();
  });

  it("reclaims a stale lease (dead worker) and completes the run", async () => {
    ensureSyncStateMock.mockResolvedValue(
      baseState({ locked_at: new Date(Date.now() - 120_000).toISOString() }),
    );
    const res = await runGoogleContactsSync(USER, ACC);
    // Push count sums contacts + groups + memberships (2 + 1 + 1).
    expect(res).toEqual({ ok: true, pull: 3, push: 4 });
    expect(pullMock).toHaveBeenCalledTimes(1);
    const finalize = patches().find((p) => "last_pull_count" in p);
    expect(finalize?.last_push_count).toBe(4);
    // Success still releases the lease and clears progress.
    expect(patches()[patches().length - 1]).toEqual({ locked_at: null });
    expect(progressClearMock).toHaveBeenCalled();
  });

  it("needs_reconnect short-circuit records the error but STILL releases the lock", async () => {
    fake.seed("gmail_accounts", [{ id: ACC, needs_reconnect: true }]);
    const res = await runGoogleContactsSync(USER, ACC);
    expect(res).toEqual({ ok: false, error: "needs_reconnect" });
    expect(pullMock).not.toHaveBeenCalled();
    expect(patches()).toEqual(
      expect.arrayContaining([{ last_error: "needs_reconnect" }, { locked_at: null }]),
    );
    expect(progressClearMock).toHaveBeenCalled();
  });

  it("pull_only mode never invokes the push side", async () => {
    ensureSyncStateMock.mockResolvedValue(baseState({ sync_mode: "pull_only" }));
    const res = await runGoogleContactsSync(USER, ACC);
    expect(res).toEqual({ ok: true, pull: 3, push: 0 });
    expect(pushMock).not.toHaveBeenCalled();
    const finalize = patches().find((p) => "last_pull_count" in p);
    expect(finalize?.last_push_count).toBe(0);
  });
});

describe("runGoogleContactsSync finalize", () => {
  it("persists new sync tokens but preserves the previous cursor when pull returns null", async () => {
    // Erasing a cursor because one incremental run didn't mint a fresh one
    // would force a full 5000-contact resync on the next tick.
    pullMock.mockResolvedValue(pullResult({ peopleSyncToken: null, groupsSyncToken: "g2" }));
    await runGoogleContactsSync(USER, ACC);
    const finalize = patches().find((p) => "people_sync_token" in p);
    expect(finalize).toMatchObject({
      people_sync_token: "prev-people", // preserved
      groups_sync_token: "g2", // replaced
      last_error: null,
      pending_bump: false,
    });
  });
});

describe("runGoogleContactsSync error taxonomy", () => {
  it("maps NeedsReconnectError to the stable needs_reconnect key, with clear + unlock", async () => {
    pullMock.mockRejectedValue(new NeedsReconnectError(ACC, "invalid_grant"));
    const res = await runGoogleContactsSync(USER, ACC);
    expect(res).toEqual({ ok: false, error: "needs_reconnect" });
    expect(patches()).toEqual(
      expect.arrayContaining([{ last_error: "needs_reconnect" }, { locked_at: null }]),
    );
    expect(progressClearMock).toHaveBeenCalled();
  });

  it("maps a 403 missing-scope PeopleApiError to missing_contacts_scope", async () => {
    pullMock.mockRejectedValue(
      new PeopleApiError("People API 403 on /people/me/connections: insufficient scope", 403),
    );
    const res = await runGoogleContactsSync(USER, ACC);
    expect(res).toEqual({ ok: false, error: "missing_contacts_scope" });
    expect(patches()).toEqual(
      expect.arrayContaining([{ last_error: "missing_contacts_scope" }, { locked_at: null }]),
    );
    expect(progressClearMock).toHaveBeenCalled();
  });

  it("truncates arbitrary error messages to 400 chars and still cleans up", async () => {
    pullMock.mockRejectedValue(new Error("x".repeat(600)));
    const res = await runGoogleContactsSync(USER, ACC);
    expect(res.ok).toBe(false);
    expect(res.error).toHaveLength(400);
    expect(patches()[patches().length - 1]).toEqual({ locked_at: null });
    expect(progressClearMock).toHaveBeenCalled();
  });
});
