// Contract for the cron routes whose whole job is to authenticate, call one
// worker with one bounded argument, and shape the answer.
//
// They are individually trivial and collectively the majority of the cron
// surface, so they are swept as a table rather than given a file each. What
// the sweep pins per route is what a caller actually depends on: the argument
// the worker is called with (the bound that stops a tick running away), the
// JSON body on success, and the JSON body plus status when the worker throws
// — the difference between a reported failure and an unhandled rejection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeSupabaseFake, mockSupabaseAdmin } from "@/lib/__fixtures__/supabase-fake";
import { JOB_WORKER_CONCURRENCY } from "@/lib/sync/config";
import { CRON_SECRET, callCron, cronRequest, handler } from "./__fixtures__/route-harness";
import { Route as backfillTick } from "./gmail-backfill-tick";
import { Route as processJobs } from "./gmail-process-jobs";
import { Route as rescueClassify } from "./gmail-rescue-classify";
import { Route as categorizeSendersRoute } from "./hooks/categorize-senders";
import { Route as enqueueEnrichment } from "./hooks/enqueue-contact-enrichment";
import { Route as runEnrichJobs } from "./hooks/run-contact-enrich-jobs";
import { Route as runFolderSummaryJobs } from "./hooks/run-folder-summary-jobs";
import { Route as runScheduledActionsRoute } from "./hooks/run-scheduled-actions";
import { Route as scheduleMeetingBots } from "./hooks/schedule-meeting-bots";
import { Route as sendDigestRoute } from "./hooks/send-digest";
import { Route as tasksCompletionScan } from "./hooks/tasks-completion-scan";

const fake = makeSupabaseFake();
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const sync = vi.hoisted(() => ({
  runMessageJobs: vi.fn<typeof import("@/lib/sync.server").runMessageJobs>(),
  tickBackfillJobs: vi.fn<typeof import("@/lib/sync.server").tickBackfillJobs>(),
  rescueStrandedEmails: vi.fn<typeof import("@/lib/sync.server").rescueStrandedEmails>(),
}));
vi.mock("@/lib/sync.server", () => sync);

const enrich = vi.hoisted(() => ({
  enqueueContactEnrichment:
    vi.fn<typeof import("@/lib/contacts/enrich-jobs.server").enqueueContactEnrichment>(),
  processContactEnrichJobs:
    vi.fn<typeof import("@/lib/contacts/enrich-jobs.server").processContactEnrichJobs>(),
}));
vi.mock("@/lib/contacts/enrich-jobs.server", () => enrich);

const categorizeSenders = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/contacts/categorize-senders.server").categorizeSenders>(),
);
vi.mock("@/lib/contacts/categorize-senders.server", () => ({ categorizeSenders }));

const processFolderSummaryJobs = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/summaries.server").processFolderSummaryJobs>(),
);
vi.mock("@/lib/summaries.server", () => ({ processFolderSummaryJobs }));

const runScheduledActions = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync/scheduled-actions").runScheduledActions>(),
);
vi.mock("@/lib/sync/scheduled-actions", () => ({ runScheduledActions }));

const sendDigests = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync/digest.server").sendDigests>(),
);
vi.mock("@/lib/sync/digest.server", () => ({ sendDigests }));

const scheduleUpcomingMeetingBots = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings-autojoin.server").scheduleUpcomingMeetingBots>(),
);
vi.mock("@/lib/meetings-autojoin.server", () => ({ scheduleUpcomingMeetingBots }));

const scanSentForTaskCompletion = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/tasks/completion.server").scanSentForTaskCompletion>(),
);
vi.mock("@/lib/tasks/completion.server", () => ({ scanSentForTaskCompletion }));

const logCronRunEvent = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/sync/cron-run-log.server").logCronRunEvent>(),
);
vi.mock("@/lib/sync/cron-run-log.server", () => ({ logCronRunEvent }));

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** One delegating cron: what it calls, and what it answers either way. */
type DelegatingCron = {
  path: string;
  route: unknown;
  delegate: { mock: { calls: unknown[][] } } & ((...args: never[]) => unknown);
  /** The exact argument list the worker must be called with. */
  args: unknown[];
  /** What the worker resolves with on the happy path. */
  result: object;
  /** The full JSON body that produces. */
  body: Record<string, unknown>;
  /** The full JSON body when the worker throws `boom`. */
  errorBody: Record<string, unknown>;
  /** Routes that also answer GET with a 405 "Use POST" stub. */
  hasGetStub?: boolean;
};

const CRONS: DelegatingCron[] = [
  {
    path: "gmail-process-jobs",
    route: processJobs,
    delegate: sync.runMessageJobs,
    args: [100, JOB_WORKER_CONCURRENCY, { priority: undefined }],
    result: { processed: 3, failed: 0 },
    body: { processed: 3, failed: 0, ok: true, run_id: RUN_ID },
    // The real message is swallowed: a queue worker's internals are not for
    // the caller, and the log line carries the detail.
    errorBody: { ok: false, error: "Job processing failed", run_id: RUN_ID },
    hasGetStub: true,
  },
  {
    path: "gmail-backfill-tick",
    route: backfillTick,
    delegate: sync.tickBackfillJobs,
    args: [2],
    result: { advanced: 1, done: 0 },
    body: { ok: true, advanced: 1, done: 0, run_id: RUN_ID },
    errorBody: { ok: false, error: "Backfill tick failed", run_id: RUN_ID },
    hasGetStub: true,
  },
  {
    path: "gmail-rescue-classify",
    route: rescueClassify,
    delegate: sync.rescueStrandedEmails,
    args: [{ limit: 50 }],
    result: { rescued: 2 },
    // The shared cronHandler wrapper: no run_id, and the real message IS
    // returned (truncated to 500 chars).
    body: { ok: true, rescued: 2 },
    errorBody: { ok: false, error: "boom" },
    hasGetStub: true,
  },
  {
    path: "hooks/enqueue-contact-enrichment",
    route: enqueueEnrichment,
    delegate: enrich.enqueueContactEnrichment,
    args: [],
    result: { enqueued: 4 },
    body: { enqueued: 4, run_id: RUN_ID },
    errorBody: { error: "boom" },
  },
  {
    path: "hooks/run-contact-enrich-jobs",
    route: runEnrichJobs,
    delegate: enrich.processContactEnrichJobs,
    args: [10],
    result: { claimed: 2, done: 2 },
    body: { claimed: 2, done: 2, run_id: RUN_ID },
    errorBody: { error: "boom" },
  },
  {
    path: "hooks/run-folder-summary-jobs",
    route: runFolderSummaryJobs,
    delegate: processFolderSummaryJobs,
    args: [3],
    result: { claimed: 1, sent: 1 },
    body: { claimed: 1, sent: 1, run_id: RUN_ID },
    errorBody: { error: "boom" },
  },
  {
    path: "hooks/categorize-senders",
    route: categorizeSendersRoute,
    delegate: categorizeSenders,
    args: [],
    result: { users: 2, labeled: 9, skipped: 1 },
    body: { users: 2, labeled: 9, skipped: 1, run_id: RUN_ID },
    errorBody: { error: "boom" },
  },
  {
    path: "hooks/run-scheduled-actions",
    route: runScheduledActionsRoute,
    delegate: runScheduledActions,
    args: [20],
    result: { claimed: 3, done: 2, retried: 1, failed: 0 },
    body: { claimed: 3, done: 2, retried: 1, failed: 0, run_id: RUN_ID },
    errorBody: { error: "boom" },
  },
  {
    path: "hooks/send-digest",
    route: sendDigestRoute,
    delegate: sendDigests,
    args: [],
    result: { users: 1, sent: 1, items: 6 },
    body: { users: 1, sent: 1, items: 6, run_id: RUN_ID },
    errorBody: { error: "boom" },
  },
  {
    path: "hooks/schedule-meeting-bots",
    route: scheduleMeetingBots,
    delegate: scheduleUpcomingMeetingBots,
    args: [RUN_ID],
    result: { scheduled: 2 },
    body: { ok: true, scheduled: 2 },
    // No message at all: the caller learns only that the tick failed.
    errorBody: { ok: false },
  },
  {
    path: "hooks/tasks-completion-scan",
    route: tasksCompletionScan,
    delegate: scanSentForTaskCompletion,
    args: [],
    result: { scanned: 12, flagged: 1 },
    body: { ok: true, runId: RUN_ID, scanned: 12, flagged: 1 },
    errorBody: { ok: false, error: "boom" },
  },
];

beforeEach(() => {
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  logCronRunEvent.mockResolvedValue();
});

describe.each(CRONS)("$path", (cron) => {
  const delegate = cron.delegate as unknown as {
    mockResolvedValue: (v: unknown) => void;
    mockRejectedValue: (e: unknown) => void;
    mock: { calls: unknown[][] };
  };

  it("calls its worker with the bound it is configured for", async () => {
    delegate.mockResolvedValue(cron.result);

    const { status, body } = await callCron<Record<string, unknown>>(cron.route, cron.path);

    expect(status).toBe(200);
    expect(delegate.mock.calls).toStrictEqual([cron.args]);
    expect(body).toStrictEqual(cron.body);
  });

  it("reports a thrown worker as a 500 body rather than an unhandled rejection", async () => {
    delegate.mockRejectedValue(new Error("boom"));

    const { status, body } = await callCron<Record<string, unknown>>(cron.route, cron.path);

    expect(status).toBe(500);
    expect(body).toStrictEqual(cron.errorBody);
  });

  if (cron.hasGetStub) {
    it("answers GET with 405 rather than running the worker", async () => {
      const res = await handler(cron.route, "GET")({ request: cronRequest(cron.path), params: {} });

      expect(res.status).toBe(405);
      expect(delegate.mock.calls).toStrictEqual([]);
    });
  }
});

describe("gmail-process-jobs query parameters", () => {
  beforeEach(() => {
    sync.runMessageJobs.mockResolvedValue({ processed: 0 } as Awaited<
      ReturnType<typeof sync.runMessageJobs>
    >);
  });

  it("routes the live-only lane by priority", async () => {
    await callCron(processJobs, "gmail-process-jobs", { priority: "0", limit: "25" });

    expect(sync.runMessageJobs).toHaveBeenCalledWith(25, JOB_WORKER_CONCURRENCY, { priority: 0 });
  });

  it("clamps the limit and the priority to their ranges", async () => {
    await callCron(processJobs, "gmail-process-jobs", { priority: "500", limit: "9999" });

    expect(sync.runMessageJobs).toHaveBeenCalledWith(200, JOB_WORKER_CONCURRENCY, { priority: 99 });
  });

  it("treats an empty priority as the mixed queue, not priority 0", async () => {
    await callCron(processJobs, "gmail-process-jobs", { priority: "" });

    expect(sync.runMessageJobs).toHaveBeenCalledWith(100, JOB_WORKER_CONCURRENCY, {
      priority: undefined,
    });
  });
});

describe("cron run log", () => {
  it("records a categorize-senders tick, and its crash", async () => {
    categorizeSenders.mockResolvedValue({ users: 2, labeled: 9, skipped: 1 });
    await callCron(categorizeSendersRoute, "hooks/categorize-senders");

    expect(logCronRunEvent).toHaveBeenCalledExactlyOnceWith(
      "categorize_senders_run",
      `run_id=${RUN_ID} users=2 labeled=9 skipped=1`,
    );

    categorizeSenders.mockRejectedValue(new Error("anthropic 529"));
    await callCron(categorizeSendersRoute, "hooks/categorize-senders");

    expect(logCronRunEvent).toHaveBeenLastCalledWith(
      "categorize_senders_run",
      `run_id=${RUN_ID} tick crashed`,
      "anthropic 529",
    );
  });

  it("logs a scheduled-actions tick only when it claimed work", async () => {
    runScheduledActions.mockResolvedValue({ claimed: 0, done: 0, retried: 0, failed: 0 });
    await callCron(runScheduledActionsRoute, "hooks/run-scheduled-actions");

    // This cron ticks every minute; an idle tick must not write a row.
    expect(logCronRunEvent).not.toHaveBeenCalled();

    runScheduledActions.mockResolvedValue({ claimed: 3, done: 2, retried: 0, failed: 1 });
    await callCron(runScheduledActionsRoute, "hooks/run-scheduled-actions");

    expect(logCronRunEvent).toHaveBeenCalledExactlyOnceWith(
      "scheduled_actions_run",
      `run_id=${RUN_ID} claimed=3 done=2 retried=0 failed=1`,
      "1 action(s) failed terminally",
    );
  });

  it("logs a digest tick only when it actually sent", async () => {
    sendDigests.mockResolvedValue({ users: 4, sent: 0, items: 0 });
    await callCron(sendDigestRoute, "hooks/send-digest");

    expect(logCronRunEvent).not.toHaveBeenCalled();

    sendDigests.mockResolvedValue({ users: 4, sent: 2, items: 11 });
    await callCron(sendDigestRoute, "hooks/send-digest");

    expect(logCronRunEvent).toHaveBeenCalledExactlyOnceWith(
      "send_digest_run",
      `run_id=${RUN_ID} users=4 sent=2 items=11`,
    );
  });
});
