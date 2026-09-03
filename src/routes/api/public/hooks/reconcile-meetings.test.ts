// Contract for the meeting reconciliation tick — the webhook fallback that
// picks up recordings Recall never told us about, plus the backstop that
// force-leaves a bot stuck in a call past the user's auto-leave window.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  type SeedRow,
} from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron } from "../__fixtures__/route-harness";
import { Route } from "./reconcile-meetings";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const syncMeetingFromRecall = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings.server").syncMeetingFromRecall>(),
);
const loadBotConfig = vi.hoisted(() =>
  vi.fn<typeof import("@/lib/meetings.server").loadBotConfig>(),
);
vi.mock("@/lib/meetings.server", () => ({ syncMeetingFromRecall, loadBotConfig }));

const leaveBot = vi.hoisted(() => vi.fn<typeof import("@/lib/recall.server").leaveBot>());
vi.mock("@/lib/recall.server", () => ({ leaveBot }));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const USER_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const MINUTE = 60_000;
const PATH = "hooks/reconcile-meetings";

type ReconcileBody = { ok: boolean; reconciled?: number; forcedLeaves?: number };

function meeting(over: SeedRow<"meetings"> = {}): SeedRow<"meetings"> {
  return {
    id: MEETING_ID,
    user_id: USER_ID,
    recall_bot_id: "bot-1",
    status: "recording",
    title: "Weekly sync",
    started_at: new Date(NOW - 10 * MINUTE).toISOString(),
    scheduled_start: null,
    created_at: new Date(NOW - 20 * MINUTE).toISOString(),
    updated_at: new Date(NOW - MINUTE).toISOString(),
    ...over,
  };
}

const BOT_CONFIG = {
  botName: "Atzro",
  chatMessage: null,
  chatResendOnJoin: true,
  imageB64: null,
  autoLeaveEnabled: true,
  autoLeaveMinutes: 60,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  syncMeetingFromRecall.mockResolvedValue("recording");
  loadBotConfig.mockResolvedValue(BOT_CONFIG);
  leaveBot.mockResolvedValue(undefined as Awaited<ReturnType<typeof leaveBot>>);
});

describe("selection", () => {
  it("reconciles every non-terminal meeting that has a bot", async () => {
    fake.seed("meetings", [meeting()]);

    const { status, body } = await callCron<ReconcileBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toStrictEqual({ ok: true, reconciled: 1, forcedLeaves: 0 });
    expect(syncMeetingFromRecall).toHaveBeenCalledTimes(1);
    expect(syncMeetingFromRecall.mock.calls[0]?.[0]).toMatchObject({ id: MEETING_ID });
  });

  it("asks only for bot-backed meetings in an active status, bounded per run", async () => {
    fake.seed("meetings", [meeting()]);

    await callCron<ReconcileBody>(Route, PATH);

    const select = fake.calls.selects.find((s) => s.table === "meetings");
    expect(select?.filters).toStrictEqual([
      { op: "not", col: "recall_bot_id", value: null, extra: "is" },
      {
        op: "in",
        col: "status",
        value: ["scheduled", "joining", "recording"],
        extra: undefined,
      },
      {
        op: "or",
        col: undefined,
        value: `scheduled_start.is.null,scheduled_start.lte.${new Date(NOW + 5 * MINUTE).toISOString()}`,
        extra: undefined,
      },
    ]);
    expect(select?.limit).toBe(25);
  });

  it("leaves a far-future scheduled meeting for a later tick", async () => {
    fake.seed("meetings", [
      meeting({
        status: "scheduled",
        started_at: null,
        scheduled_start: new Date(NOW + 60 * MINUTE).toISOString(),
      }),
    ]);

    const { body } = await callCron<ReconcileBody>(Route, PATH);

    expect(syncMeetingFromRecall).not.toHaveBeenCalled();
    expect(body).toStrictEqual({ ok: true, reconciled: 0, forcedLeaves: 0 });
  });

  it("writes nothing itself — persistence belongs to the sync it delegates to", async () => {
    fake.seed("meetings", [meeting()]);

    await callCron<ReconcileBody>(Route, PATH);

    expect(writeCount(fake)).toBe(0);
  });
});

describe("force-leave backstop", () => {
  it("pulls a bot out once it is past the auto-leave window plus the grace", async () => {
    fake.seed("meetings", [meeting({ started_at: new Date(NOW - 66 * MINUTE).toISOString() })]);

    const { body } = await callCron<ReconcileBody>(Route, PATH);

    expect(leaveBot).toHaveBeenCalledWith("bot-1");
    expect(body).toStrictEqual({ ok: true, reconciled: 1, forcedLeaves: 1 });
  });

  it("gives Recall's own timeout the first go — 5 minutes of grace", async () => {
    fake.seed("meetings", [meeting({ started_at: new Date(NOW - 64 * MINUTE).toISOString() })]);

    await callCron<ReconcileBody>(Route, PATH);

    expect(leaveBot).not.toHaveBeenCalled();
  });

  it("respects a user who turned auto-leave off", async () => {
    loadBotConfig.mockResolvedValue({ ...BOT_CONFIG, autoLeaveEnabled: false });
    fake.seed("meetings", [meeting({ started_at: new Date(NOW - 5 * 60 * MINUTE).toISOString() })]);

    await callCron<ReconcileBody>(Route, PATH);

    expect(leaveBot).not.toHaveBeenCalled();
  });

  it("never force-leaves a meeting that has not started", async () => {
    fake.seed("meetings", [
      meeting({
        status: "scheduled",
        started_at: null,
        scheduled_start: new Date(NOW - 5 * 60 * MINUTE).toISOString(),
        created_at: new Date(NOW - 6 * 60 * MINUTE).toISOString(),
      }),
    ]);

    const { body } = await callCron<ReconcileBody>(Route, PATH);

    // status is `scheduled`, so the backstop does not apply however old it is.
    expect(leaveBot).not.toHaveBeenCalled();
    expect(body).toMatchObject({ reconciled: 1, forcedLeaves: 0 });
  });

  it("falls back to scheduled_start, then created_at, for the age reference", async () => {
    fake.seed("meetings", [
      meeting({
        started_at: null,
        scheduled_start: new Date(NOW - 90 * MINUTE).toISOString(),
      }),
    ]);

    await callCron<ReconcileBody>(Route, PATH);

    expect(leaveBot).toHaveBeenCalledWith("bot-1");
  });

  it("loads a user's bot config once per tick, not once per meeting", async () => {
    fake.seed("meetings", [
      meeting({ started_at: new Date(NOW - 66 * MINUTE).toISOString() }),
      meeting({
        id: "33333333-3333-4333-8333-333333333333",
        recall_bot_id: "bot-2",
        started_at: new Date(NOW - 70 * MINUTE).toISOString(),
      }),
    ]);

    const { body } = await callCron<ReconcileBody>(Route, PATH);

    expect(loadBotConfig).toHaveBeenCalledTimes(1);
    expect(leaveBot.mock.calls.map((c) => c[0])).toStrictEqual(["bot-1", "bot-2"]);
    expect(body).toMatchObject({ reconciled: 2, forcedLeaves: 2 });
  });

  it("still reconciles the meeting when the force-leave fails", async () => {
    leaveBot.mockRejectedValue(new Error("recall 409 already left"));
    fake.seed("meetings", [meeting({ started_at: new Date(NOW - 66 * MINUTE).toISOString() })]);

    const { status, body } = await callCron<ReconcileBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toStrictEqual({ ok: true, reconciled: 1, forcedLeaves: 0 });
    expect(syncMeetingFromRecall).toHaveBeenCalledTimes(1);
  });
});

describe("failure handling", () => {
  it("returns 500 when a per-meeting sync throws", async () => {
    fake.seed("meetings", [meeting()]);
    syncMeetingFromRecall.mockRejectedValue(new Error("recall unreachable"));

    const { status, body } = await callCron<ReconcileBody>(Route, PATH);

    // The route has no per-meeting guard around syncMeetingFromRecall, so one
    // bad meeting aborts the tick. Deliberate: the next tick retries the whole
    // set, and the alternative would be a silent partial sweep.
    expect(status).toBe(500);
    expect(body).toStrictEqual({ ok: false });
  });

  it("returns 500 when the meetings query throws", async () => {
    fake.onSelect("meetings", () => {
      throw new Error("statement timeout");
    });

    const { status, body } = await callCron<ReconcileBody>(Route, PATH);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ ok: false });
    expect(syncMeetingFromRecall).not.toHaveBeenCalled();
  });

  it("treats a failed meetings read as an empty set rather than a crash", async () => {
    fake.onSelect("meetings", () => ({ message: "permission denied" }));

    const { status, body } = await callCron<ReconcileBody>(Route, PATH);

    // The route destructures only `data`, so a returned error reads as "no
    // meetings" — a quiet no-op tick, not a 500.
    expect(status).toBe(200);
    expect(body).toStrictEqual({ ok: true, reconciled: 0, forcedLeaves: 0 });
  });
});
