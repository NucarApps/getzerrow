// Unit tests for the per-folder daily digest (src/lib/summaries.server.ts).
// Contracts pinned here:
//
//   - computeNextRun returns the next instant STRICTLY after `from` whose
//     local wall clock matches hour:minute in the schedule's timezone,
//     including across a DST transition (the naive "+24 h" answer is wrong
//     by an hour on those two days a year);
//   - runFolderSummary refuses a schedule whose folder belongs to a
//     different user before any model call, records the failure on the row
//     and still advances next_run_at so a poisoned schedule cannot wedge
//     the cron;
//   - processFolderSummaryJobs marks each claimed job done/failed
//     independently.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin, writeCount } from "@/lib/__fixtures__/supabase-fake";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const { summarizeFolderEmails, insertMessage, getEmailsDecrypted } = vi.hoisted(() => ({
  summarizeFolderEmails: vi.fn<typeof import("./ai.server").summarizeFolderEmails>(),
  insertMessage: vi.fn<typeof import("./gmail.server").insertMessage>(),
  getEmailsDecrypted: vi.fn<typeof import("./sync/encrypted-reader").getEmailsDecrypted>(),
}));
vi.mock("./ai.server", () => ({ summarizeFolderEmails }));
vi.mock("./gmail.server", () => ({ insertMessage }));
vi.mock("./sync/encrypted-reader", () => ({ getEmailsDecrypted }));

import {
  computeNextRun,
  enqueueFolderSummaryJob,
  processFolderSummaryJobs,
  runFolderSummary,
} from "./summaries.server";

const SCHEDULE = "11111111-1111-4111-8111-111111111111";
const FOLDER = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const EMAIL = "55555555-5555-4555-8555-555555555555";
const USER = "user-1";
const OTHER_USER = "user-2";
const NOW = "2026-03-01T12:00:00Z";

function seedSchedule(overrides?: { folderOwner?: string; lastRunAt?: string | null }) {
  fake.seed("folder_summary_schedules", [
    {
      id: SCHEDULE,
      user_id: USER,
      folder_id: FOLDER,
      gmail_account_id: ACCOUNT,
      name: "Receipts digest",
      instructions: "Group by vendor.",
      hour: 9,
      minute: 30,
      timezone: "UTC",
      last_run_at: overrides?.lastRunAt ?? null,
    },
  ]);
  fake.seed("folders", [
    {
      id: FOLDER,
      user_id: overrides?.folderOwner ?? USER,
      name: "Receipts",
      gmail_account_id: ACCOUNT,
    },
  ]);
  fake.seed("gmail_accounts", [{ id: ACCOUNT, user_id: USER, email_address: "me@acme.com" }]);
}

function seedOneEmailInWindow() {
  fake.seed("emails", [
    {
      id: EMAIL,
      user_id: USER,
      folder_id: FOLDER,
      received_at: "2026-03-01T10:00:00Z",
    },
  ]);
  getEmailsDecrypted.mockResolvedValue({
    rows: [
      {
        id: EMAIL,
        from_addr: "billing@acme.com",
        from_name: "Acme",
        subject: "Invoice",
        snippet: "due friday",
        received_at: "2026-03-01T10:00:00Z",
      },
    ] as unknown as Awaited<ReturnType<typeof getEmailsDecrypted>>["rows"],
    error: null,
  });
}

beforeEach(() => {
  fake.reset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  getEmailsDecrypted.mockResolvedValue({ rows: [], error: null });
  summarizeFolderEmails.mockResolvedValue({
    subject: "3 receipts",
    body_text: "plain",
    body_html: "<p>rich</p>",
    _fallback: false,
  });
  insertMessage.mockResolvedValue({ id: "gmail-msg-1" } as Awaited<
    ReturnType<typeof insertMessage>
  >);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeNextRun", () => {
  it("returns today's slot when it is still ahead", () => {
    expect(computeNextRun(9, 30, "UTC", new Date("2026-03-01T08:00:00Z")).toISOString()).toBe(
      "2026-03-01T09:30:00.000Z",
    );
  });

  it("rolls to tomorrow when the slot has just passed", () => {
    expect(computeNextRun(9, 30, "UTC", new Date("2026-03-01T09:30:01Z")).toISOString()).toBe(
      "2026-03-02T09:30:00.000Z",
    );
  });

  it("treats the exact slot instant as already gone (strictly after)", () => {
    expect(computeNextRun(9, 30, "UTC", new Date("2026-03-01T09:30:00Z")).toISOString()).toBe(
      "2026-03-02T09:30:00.000Z",
    );
  });

  it("keeps the local wall clock across the spring-forward DST boundary", () => {
    // 2026-03-08 is when America/New_York moves EST → EDT. The 09:00 local
    // slot is 14:00Z the day before and 13:00Z the day after.
    expect(
      computeNextRun(9, 0, "America/New_York", new Date("2026-03-07T15:00:00Z")).toISOString(),
    ).toBe("2026-03-08T13:00:00.000Z");
    expect(
      computeNextRun(9, 0, "America/New_York", new Date("2026-03-06T15:00:00Z")).toISOString(),
    ).toBe("2026-03-07T14:00:00.000Z");
  });

  it("keeps the local wall clock across the fall-back DST boundary", () => {
    // 2026-11-01: EDT → EST. The 09:00 local slot moves from 13:00Z to 14:00Z.
    expect(
      computeNextRun(9, 0, "America/New_York", new Date("2026-10-31T15:00:00Z")).toISOString(),
    ).toBe("2026-11-01T14:00:00.000Z");
  });

  it("handles a timezone with a half-hour offset", () => {
    expect(
      computeNextRun(9, 30, "Asia/Kolkata", new Date("2026-03-01T00:00:00Z")).toISOString(),
    ).toBe("2026-03-01T04:00:00.000Z");
  });
});

describe("runFolderSummary", () => {
  it("reports a missing schedule without writing anything", async () => {
    await expect(runFolderSummary(SCHEDULE)).resolves.toStrictEqual({
      ok: false,
      error: expect.stringContaining("no rows in folder_summary_schedules") as unknown as string,
    });
    expect(writeCount(fake)).toBe(0);
  });

  it("refuses a schedule whose folder belongs to another user, with no model call", async () => {
    seedSchedule({ folderOwner: OTHER_USER });
    seedOneEmailInWindow();

    const result = await runFolderSummary(SCHEDULE);

    expect(result).toStrictEqual({ ok: false, error: "Folder not found" });
    expect(
      summarizeFolderEmails,
      "another user's folder must never reach the model",
    ).not.toHaveBeenCalled();
    expect(insertMessage).not.toHaveBeenCalled();
    // The failure is recorded and the schedule still advances, so a broken
    // schedule cannot pin the cron on the same row forever.
    expect(fake.calls.updates.map((w) => [w.table, w.payload, w.filters])).toStrictEqual([
      [
        "folder_summary_schedules",
        { next_run_at: "2026-03-02T09:30:00.000Z", last_error: "Folder not found" },
        [{ op: "eq", col: "id", value: SCHEDULE, extra: undefined }],
      ],
    ]);
  });

  it("refuses a schedule pointing at a missing gmail account", async () => {
    seedSchedule();
    fake.seed("gmail_accounts", []);

    await expect(runFolderSummary(SCHEDULE)).resolves.toStrictEqual({
      ok: false,
      error: "Gmail account not found",
    });
    expect(summarizeFolderEmails).not.toHaveBeenCalled();
  });

  it("advances the schedule without sending anything when the window is empty", async () => {
    seedSchedule();

    await expect(runFolderSummary(SCHEDULE)).resolves.toStrictEqual({ ok: true, emails: 0 });
    expect(summarizeFolderEmails).not.toHaveBeenCalled();
    expect(insertMessage).not.toHaveBeenCalled();
    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      last_run_at: NOW.replace("Z", ".000Z"),
      next_run_at: "2026-03-02T09:30:00.000Z",
      last_error: null,
    });
  });

  it("reads the window from last_run_at and inserts the digest into the inbox", async () => {
    seedSchedule({ lastRunAt: "2026-03-01T06:00:00Z" });
    seedOneEmailInWindow();

    const result = await runFolderSummary(SCHEDULE);

    expect(result).toStrictEqual({ ok: true, emails: 1 });
    const emailRead = fake.calls.selects.find((s) => s.table === "emails");
    expect(emailRead?.filters).toStrictEqual([
      { op: "eq", col: "user_id", value: USER, extra: undefined },
      { op: "eq", col: "folder_id", value: FOLDER, extra: undefined },
      { op: "gte", col: "received_at", value: "2026-03-01T06:00:00.000Z", extra: undefined },
      { op: "lt", col: "received_at", value: "2026-03-01T12:00:00.000Z", extra: undefined },
    ]);
    expect(summarizeFolderEmails.mock.calls[0]?.[0]).toMatchObject({
      folderName: "Receipts",
      instructions: "Group by vendor.",
    });

    const [accountId, raw, labels] = insertMessage.mock.calls[0] ?? [];
    expect(accountId).toBe(ACCOUNT);
    expect(labels).toStrictEqual(["INBOX", "UNREAD"]);
    expect(raw).toContain("From: me@acme.com");
    expect(raw).toContain("To: me@acme.com");
    // The subject is RFC 2047 base64-encoded so non-ASCII digests survive.
    expect(raw).toContain(
      `Subject: =?UTF-8?B?${Buffer.from("[Receipts digest] 3 receipts").toString("base64")}?=`,
    );
    expect(raw).toContain("plain");
    expect(raw).toContain("<p>rich</p>");
    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      last_run_at: "2026-03-01T12:00:00.000Z",
      next_run_at: "2026-03-02T09:30:00.000Z",
      last_error: null,
    });
  });

  it("notes on the row when the digest went out through the plain-text fallback", async () => {
    seedSchedule();
    seedOneEmailInWindow();
    summarizeFolderEmails.mockResolvedValue({
      subject: "3 receipts",
      body_text: "plain",
      body_html: "<p>rich</p>",
      _fallback: true,
    });

    await runFolderSummary(SCHEDULE);

    expect(fake.calls.updates[0]?.payload).toMatchObject({
      last_error: "Sent using plain-text fallback (structured AI output failed once).",
    });
  });

  it("records a delivery failure and still advances, without stamping last_run_at", async () => {
    seedSchedule();
    seedOneEmailInWindow();
    insertMessage.mockRejectedValue(new Error("Gmail 403 insufficient scope"));

    const result = await runFolderSummary(SCHEDULE);

    expect(result).toStrictEqual({ ok: false, error: "Gmail 403 insufficient scope" });
    expect(fake.calls.updates[0]?.payload).toStrictEqual({
      next_run_at: "2026-03-02T09:30:00.000Z",
      last_error: "Gmail 403 insufficient scope",
    });
  });

  it("truncates a very long failure message to fit the column", async () => {
    seedSchedule();
    seedOneEmailInWindow();
    summarizeFolderEmails.mockRejectedValue(new Error("x".repeat(900)));

    await runFolderSummary(SCHEDULE);

    expect((fake.calls.updates[0]?.payload as { last_error: string }).last_error).toHaveLength(500);
  });
});

describe("enqueueFolderSummaryJob", () => {
  it("inserts a pending job and returns its id", async () => {
    fake.onInsert("folder_summary_jobs", () => ({ data: { id: JOB } }));

    await expect(
      enqueueFolderSummaryJob({ scheduleId: SCHEDULE, userId: USER }),
    ).resolves.toStrictEqual({ jobId: JOB });
    expect(fake.calls.inserts.map((w) => [w.table, w.payload])).toStrictEqual([
      ["folder_summary_jobs", { schedule_id: SCHEDULE, user_id: USER, status: "pending" }],
    ]);
  });

  it("raises when the insert is rejected", async () => {
    fake.onInsert("folder_summary_jobs", () => ({ message: "insert denied" }));

    await expect(enqueueFolderSummaryJob({ scheduleId: SCHEDULE, userId: USER })).rejects.toThrow(
      "insert denied",
    );
  });

  // CHARACTERIZATION(summary-enqueue-no-dedupe): enqueueing twice for one
  // schedule creates two pending jobs — there is no "pending job already
  // exists" check here and no unique index behind it (migration
  // 20260527131842 creates only non-unique indexes), so a double-click
  // sends the user two identical digests. Flip when enqueue dedupes.
  it("queues a second job for a schedule that already has one pending", async () => {
    fake.seed("folder_summary_jobs", [
      { id: JOB, schedule_id: SCHEDULE, user_id: USER, status: "pending" },
    ]);
    fake.onInsert("folder_summary_jobs", () => ({ data: { id: "second-job" } }));

    await expect(
      enqueueFolderSummaryJob({ scheduleId: SCHEDULE, userId: USER }),
    ).resolves.toStrictEqual({ jobId: "second-job" });
    expect(fake.calls.inserts).toHaveLength(1);
  });
});

describe("processFolderSummaryJobs", () => {
  it("claims nothing and reports zero when the queue is empty", async () => {
    fake.onRpc("claim_folder_summary_jobs", () => ({ data: [] }));

    await expect(processFolderSummaryJobs(5)).resolves.toStrictEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(fake.calls.rpcs).toStrictEqual([
      { fn: "claim_folder_summary_jobs", args: { p_limit: 5 } },
    ]);
  });

  it("raises when the claim RPC fails", async () => {
    fake.onRpc("claim_folder_summary_jobs", () => ({ error: { message: "claim failed" } }));

    await expect(processFolderSummaryJobs(5)).rejects.toThrow("claim failed");
  });

  it("marks a claimed job done with its email count", async () => {
    seedSchedule({ lastRunAt: "2026-03-01T06:00:00Z" });
    seedOneEmailInWindow();
    fake.onRpc("claim_folder_summary_jobs", () => ({
      data: [{ id: JOB, schedule_id: SCHEDULE, user_id: USER }],
    }));

    await expect(processFolderSummaryJobs(5)).resolves.toStrictEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
    });
    const jobUpdate = fake.calls.updates.find((w) => w.table === "folder_summary_jobs");
    expect(jobUpdate?.payload).toStrictEqual({
      status: "done",
      error: null,
      emails_count: 1,
      finished_at: "2026-03-01T12:00:00.000Z",
      updated_at: "2026-03-01T12:00:00.000Z",
    });
    expect(jobUpdate?.filters).toStrictEqual([
      { op: "eq", col: "id", value: JOB, extra: undefined },
    ]);
  });

  it("fails the job when its schedule points at another user's folder, with no model call", async () => {
    seedSchedule({ folderOwner: OTHER_USER });
    seedOneEmailInWindow();
    fake.onRpc("claim_folder_summary_jobs", () => ({
      data: [{ id: JOB, schedule_id: SCHEDULE, user_id: USER }],
    }));

    await expect(processFolderSummaryJobs(5)).resolves.toStrictEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(summarizeFolderEmails).not.toHaveBeenCalled();
    const jobUpdate = fake.calls.updates.find((w) => w.table === "folder_summary_jobs");
    expect(jobUpdate?.payload).toMatchObject({ status: "failed", error: "Folder not found" });
  });

  it("fails one job and still finishes the next", async () => {
    fake.onRpc("claim_folder_summary_jobs", () => ({
      data: [
        { id: JOB, schedule_id: "missing-schedule", user_id: USER },
        { id: "job-2", schedule_id: SCHEDULE, user_id: USER },
      ],
    }));
    seedSchedule();

    await expect(processFolderSummaryJobs(5)).resolves.toStrictEqual({
      processed: 2,
      succeeded: 1,
      failed: 1,
    });
    const statuses = fake.calls.updates
      .filter((w) => w.table === "folder_summary_jobs")
      .map((w) => (w.payload as { status: string }).status);
    expect(statuses).toStrictEqual(["failed", "done"]);
  });
});
