// Contract for the cron hooks that select a bounded batch of rows and then
// iterate it. They share a shape the delegating crons do not: a failed
// selection is a 500, but a failure on ONE row is counted and the loop goes
// on — so one bad folder or account can never stall the whole fleet.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writesTo } from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron } from "../__fixtures__/route-harness";
import { Route as consolidateLabelDuplicates } from "./consolidate-label-duplicates";
import { Route as relearnFolders } from "./relearn-folders";
import { Route as runFolderSummaries } from "./run-folder-summaries";
import { Route as syncCalendarContacts } from "./sync-calendar-contacts";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const sync = vi.hoisted(() => ({
  learnFromLinkedLabel: vi.fn<typeof import("@/lib/sync.server").learnFromLinkedLabel>(),
  regenerateFolderProfile: vi.fn<typeof import("@/lib/sync.server").regenerateFolderProfile>(),
}));
vi.mock("@/lib/sync.server", () => sync);

const summaries = vi.hoisted(() => ({
  computeNextRun: vi.fn<typeof import("@/lib/summaries.server").computeNextRun>(),
  enqueueFolderSummaryJob: vi.fn<typeof import("@/lib/summaries.server").enqueueFolderSummaryJob>(),
}));
vi.mock("@/lib/summaries.server", () => summaries);

const syncCalendarContactsFn = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/calendar.server").syncCalendarContacts>(),
);
vi.mock("@/lib/calendar.server", () => ({ syncCalendarContacts: syncCalendarContactsFn }));

const consolidateLabelDuplicatesImpl = vi.hoisted(() =>
  vi.fn<
    typeof import("@/lib/contacts/label-duplicates.functions").consolidateLabelDuplicatesImpl
  >(),
);
vi.mock("@/lib/contacts/label-duplicates.functions", () => ({ consolidateLabelDuplicatesImpl }));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const FOLDER_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  sync.learnFromLinkedLabel.mockResolvedValue({
    learned: 5,
    ingested: 5,
    claimed: 0,
    profile: undefined,
  });
  sync.regenerateFolderProfile.mockResolvedValue(
    undefined as Awaited<ReturnType<typeof sync.regenerateFolderProfile>>,
  );
  summaries.computeNextRun.mockReturnValue(new Date(NOW + 86_400_000));
  summaries.enqueueFolderSummaryJob.mockResolvedValue({ jobId: "job-1" });
  syncCalendarContactsFn.mockResolvedValue({ contacts: 4, pages: 1, truncated: false });
  consolidateLabelDuplicatesImpl.mockResolvedValue({
    mergedClusters: 1,
    mergedLabels: 2,
    failedLabels: 0,
    errors: [],
  });
});

const PATH_RELEARN = "hooks/relearn-folders";

describe("relearn-folders", () => {
  type Body = {
    checked?: number;
    ran?: number;
    succeeded?: number;
    failed?: number;
    error?: string;
  };

  function folder(over: Record<string, unknown> = {}) {
    return {
      id: FOLDER_ID,
      user_id: USER_ID,
      gmail_label_id: null,
      auto_relearn: true,
      relearn_threshold: 25,
      emails_since_learn: 30,
      last_learned_at: new Date(NOW - 86_400_000).toISOString(),
      ...over,
    };
  }

  it("relearns only folders that have crossed their own threshold", async () => {
    fake.seed("folders", [
      folder(),
      folder({ id: "33333333-3333-4333-8333-333333333333", emails_since_learn: 24 }),
    ]);

    const { status, body } = await callCron<Body>(relearnFolders, PATH_RELEARN);

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      checked: 2,
      ran: 1,
      succeeded: 1,
      failed: 0,
      run_id: RUN_ID,
    });
    expect(sync.regenerateFolderProfile).toHaveBeenCalledExactlyOnceWith(FOLDER_ID);
  });

  it("defaults a missing threshold to 25", async () => {
    fake.seed("folders", [folder({ relearn_threshold: null, emails_since_learn: 25 })]);

    const { body } = await callCron<Body>(relearnFolders, PATH_RELEARN);

    expect(body).toMatchObject({ ran: 1 });
  });

  it("learns from the linked Gmail label when the folder has one", async () => {
    fake.seed("folders", [folder({ gmail_label_id: "Label_7" })]);

    await callCron<Body>(relearnFolders, PATH_RELEARN);

    expect(sync.learnFromLinkedLabel).toHaveBeenCalledExactlyOnceWith(FOLDER_ID, USER_ID);
    expect(sync.regenerateFolderProfile).not.toHaveBeenCalled();
  });

  it("counts a failing folder and carries on", async () => {
    fake.seed("folders", [folder(), folder({ id: "33333333-3333-4333-8333-333333333333" })]);
    sync.regenerateFolderProfile
      .mockRejectedValueOnce(new Error("anthropic 429"))
      .mockResolvedValueOnce(undefined as Awaited<ReturnType<typeof sync.regenerateFolderProfile>>);

    const { status, body } = await callCron<Body>(relearnFolders, PATH_RELEARN);

    expect(status).toBe(200);
    expect(body).toMatchObject({ ran: 2, succeeded: 1, failed: 1 });
  });

  it("asks only for auto-relearn folders, bounded per tick", async () => {
    await callCron<Body>(relearnFolders, PATH_RELEARN);

    const select = fake.calls.selects.find((s) => s.table === "folders");
    expect(select?.filters).toStrictEqual([
      { op: "eq", col: "auto_relearn", value: true, extra: undefined },
    ]);
    expect(select?.limit).toBe(50);
  });

  it("returns 500 when the folder query fails", async () => {
    fake.onSelect("folders", () => ({ message: "statement timeout" }));

    const { status, body } = await callCron<Body>(relearnFolders, PATH_RELEARN);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "statement timeout" });
  });
});

const PATH_SUMMARIES = "hooks/run-folder-summaries";

describe("run-folder-summaries", () => {
  type Body = { processed?: number; enqueued?: number; failed?: number; error?: string };

  function schedule(over: Record<string, unknown> = {}) {
    return {
      id: "44444444-4444-4444-8444-444444444444",
      user_id: USER_ID,
      hour: 8,
      minute: 30,
      timezone: "Europe/London",
      enabled: true,
      next_run_at: new Date(NOW - 60_000).toISOString(),
      ...over,
    };
  }

  it("enqueues a due schedule and advances it immediately", async () => {
    fake.seed("folder_summary_schedules", [schedule()]);

    const { status, body } = await callCron<Body>(runFolderSummaries, PATH_SUMMARIES);

    expect(status).toBe(200);
    expect(body).toStrictEqual({ processed: 1, enqueued: 1, failed: 0, run_id: RUN_ID });
    expect(summaries.enqueueFolderSummaryJob).toHaveBeenCalledExactlyOnceWith({
      scheduleId: "44444444-4444-4444-8444-444444444444",
      userId: USER_ID,
    });
    expect(summaries.computeNextRun).toHaveBeenCalledWith(8, 30, "Europe/London");
    // Advancing in the same tick is what stops the next tick re-enqueueing
    // the same schedule before the worker has run it.
    expect(
      writesTo(fake, "updates", "folder_summary_schedules").map((u) => u.payload),
    ).toStrictEqual([{ next_run_at: new Date(NOW + 86_400_000).toISOString() }]);
  });

  it("skips a schedule whose next run is still in the future", async () => {
    fake.seed("folder_summary_schedules", [
      schedule({ next_run_at: new Date(NOW + 60_000).toISOString() }),
    ]);

    const { body } = await callCron<Body>(runFolderSummaries, PATH_SUMMARIES);

    expect(body).toMatchObject({ processed: 0, enqueued: 0 });
    expect(summaries.enqueueFolderSummaryJob).not.toHaveBeenCalled();
  });

  it("skips a disabled schedule however overdue it is", async () => {
    fake.seed("folder_summary_schedules", [
      schedule({ enabled: false, next_run_at: new Date(NOW - 86_400_000).toISOString() }),
    ]);

    const { body } = await callCron<Body>(runFolderSummaries, PATH_SUMMARIES);

    expect(body).toMatchObject({ processed: 0 });
  });

  it("counts a failing enqueue and leaves its schedule unadvanced", async () => {
    fake.seed("folder_summary_schedules", [schedule()]);
    summaries.enqueueFolderSummaryJob.mockRejectedValue(new Error("insert failed"));

    const { status, body } = await callCron<Body>(runFolderSummaries, PATH_SUMMARIES);

    expect(status).toBe(200);
    expect(body).toMatchObject({ processed: 1, enqueued: 0, failed: 1 });
    expect(writesTo(fake, "updates", "folder_summary_schedules")).toStrictEqual([]);
  });

  it("returns 500 when the schedule query fails", async () => {
    fake.onSelect("folder_summary_schedules", () => ({ message: "permission denied" }));

    const { status, body } = await callCron<Body>(runFolderSummaries, PATH_SUMMARIES);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "permission denied" });
  });
});

const PATH_CALENDAR = "hooks/sync-calendar-contacts";

describe("sync-calendar-contacts", () => {
  type Body = { checked?: number; succeeded?: number; failed?: number; error?: string };

  function account(over: Record<string, unknown> = {}) {
    return {
      id: "55555555-5555-4555-8555-555555555555",
      user_id: USER_ID,
      calendar_guard_enabled: true,
      calendar_access: true,
      calendar_synced_at: null,
      ...over,
    };
  }

  it("refreshes attendees for every guarded account with calendar access", async () => {
    fake.seed("gmail_accounts", [account()]);

    const { status, body } = await callCron<Body>(syncCalendarContacts, PATH_CALENDAR);

    expect(status).toBe(200);
    expect(body).toStrictEqual({ checked: 1, succeeded: 1, failed: 0, run_id: RUN_ID });
    expect(syncCalendarContactsFn).toHaveBeenCalledExactlyOnceWith(
      "55555555-5555-4555-8555-555555555555",
      USER_ID,
    );
  });

  it.each([
    ["the guard is off", { calendar_guard_enabled: false }],
    ["calendar access was never granted", { calendar_access: false }],
  ])("skips an account where %s", async (_name, over) => {
    fake.seed("gmail_accounts", [account(over)]);

    const { body } = await callCron<Body>(syncCalendarContacts, PATH_CALENDAR);

    expect(body).toMatchObject({ checked: 0 });
    expect(syncCalendarContactsFn).not.toHaveBeenCalled();
  });

  it("counts a failing account and carries on", async () => {
    fake.seed("gmail_accounts", [
      account(),
      account({ id: "66666666-6666-4666-8666-666666666666" }),
    ]);
    syncCalendarContactsFn
      .mockRejectedValueOnce(new Error("calendar 403"))
      .mockResolvedValueOnce({ contacts: 1, pages: 1, truncated: false });

    const { body } = await callCron<Body>(syncCalendarContacts, PATH_CALENDAR);

    expect(body).toMatchObject({ checked: 2, succeeded: 1, failed: 1 });
  });

  it("returns 500 when the account query fails", async () => {
    fake.onSelect("gmail_accounts", () => ({ message: "connection reset" }));

    const { status, body } = await callCron<Body>(syncCalendarContacts, PATH_CALENDAR);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "connection reset" });
  });
});

const PATH_CONSOLIDATE = "hooks/consolidate-label-duplicates";

describe("consolidate-label-duplicates", () => {
  type Body = {
    users_with_collisions?: number;
    processed?: number;
    results?: Array<Record<string, unknown>>;
    error?: string;
  };

  it("merges only the users that actually have a name_key collision", async () => {
    fake.seedRaw("contact_groups", [
      { user_id: USER_ID, parent_group_id: null, name_key: "acme" },
      { user_id: USER_ID, parent_group_id: null, name_key: "acme" },
      // A different user with two distinct keys is not a collision.
      { user_id: "77777777-7777-4777-8777-777777777777", parent_group_id: null, name_key: "a" },
      { user_id: "77777777-7777-4777-8777-777777777777", parent_group_id: null, name_key: "b" },
    ]);

    const { status, body } = await callCron<Body>(consolidateLabelDuplicates, PATH_CONSOLIDATE);

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      users_with_collisions: 1,
      processed: 1,
      results: [
        {
          user_id: USER_ID,
          mergedClusters: 1,
          mergedLabels: 2,
          failedLabels: 0,
          errors: [],
        },
      ],
      run_id: RUN_ID,
    });
    expect(consolidateLabelDuplicatesImpl).toHaveBeenCalledTimes(1);
  });

  it("treats the same name under different parents as distinct", async () => {
    fake.seedRaw("contact_groups", [
      { user_id: USER_ID, parent_group_id: null, name_key: "acme" },
      { user_id: USER_ID, parent_group_id: FOLDER_ID, name_key: "acme" },
    ]);

    const { body } = await callCron<Body>(consolidateLabelDuplicates, PATH_CONSOLIDATE);

    expect(body).toMatchObject({ users_with_collisions: 0, processed: 0 });
  });

  it("caps the tick at five users while still reporting the full backlog", async () => {
    fake.seed(
      "contact_groups",
      Array.from({ length: 7 }, (_, i) => i).flatMap((i) => [
        { user_id: `user-${i}`, parent_group_id: null, name_key: "acme" },
        { user_id: `user-${i}`, parent_group_id: null, name_key: "acme" },
      ]),
    );

    const { body } = await callCron<Body>(consolidateLabelDuplicates, PATH_CONSOLIDATE);

    // The caller re-runs until users_with_collisions reaches 0.
    expect(body).toMatchObject({ users_with_collisions: 7, processed: 5 });
  });

  it("returns 500 when the label query fails", async () => {
    fake.onSelect("contact_groups", () => ({ message: "relation does not exist" }));

    const { status, body } = await callCron<Body>(consolidateLabelDuplicates, PATH_CONSOLIDATE);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "relation does not exist" });
  });

  it("returns 500 when a per-user merge throws", async () => {
    fake.seedRaw("contact_groups", [
      { user_id: USER_ID, parent_group_id: null, name_key: "acme" },
      { user_id: USER_ID, parent_group_id: null, name_key: "acme" },
    ]);
    consolidateLabelDuplicatesImpl.mockRejectedValue(new Error("merge deadlock"));

    const { status, body } = await callCron<Body>(consolidateLabelDuplicates, PATH_CONSOLIDATE);

    // No per-user guard here, unlike its sibling loops: a backfill that half
    // ran is worse than one the operator re-runs.
    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "merge deadlock" });
  });
});
