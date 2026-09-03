// Contract for the folder_example_write failure-spike alert hook: the window
// it counts over, the alert row it records, the webhook it pages, the
// cooldown that keeps one incident to one page, and the retention delete that
// stops the failure log growing forever.
//
// The pure grouping/cooldown rule is unit-tested in folder-write-alerts and
// alert-cooldown; what is only testable here is the wiring — which queries
// feed the rule, what is written when it fires, and what happens when a step
// of that chain fails.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  writesTo,
} from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "../__fixtures__/route-harness";
import { Route } from "./check-folder-write-alerts";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;
const PATH = "hooks/check-folder-write-alerts";

type AlertBody = {
  ok?: boolean;
  checked?: number;
  window_minutes?: number;
  threshold?: number;
  fired?: Array<{ error_code: string; folder_id: string | null; failure_count: number }>;
  run_id?: string;
  error?: string;
};

let fetchMock: ReturnType<typeof vi.fn>;

/** `count` failures for one group, spread a minute apart inside the window. */
function seedFailures(
  count: number,
  over: { error_code?: string | null; folder_id?: string | null } = {},
) {
  fake.seed(
    "folder_write_failures",
    Array.from({ length: count }, (_, i) => ({
      error_code: over.error_code === undefined ? "42703" : over.error_code,
      folder_id: over.folder_id === undefined ? FOLDER_ID : over.folder_id,
      occurred_at: new Date(NOW - (i + 1) * MINUTE).toISOString(),
    })),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(RUN_ID);
  fake.reset();
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("ALERT_WEBHOOK_URL", undefined);
  fetchMock = vi.fn(async () => new Response("ok"));
  vi.stubGlobal("fetch", fetchMock);
});

describe("quiet run", () => {
  it("reports nothing fired and still prunes the failure log", async () => {
    const { status, body } = await callCron<AlertBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      checked: 0,
      window_minutes: 15,
      threshold: 3,
      fired: [],
      run_id: RUN_ID,
    });
    expect(writesTo(fake, "inserts", "folder_write_alerts")).toStrictEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writesTo(fake, "deletes", "folder_write_failures")[0]?.filters).toStrictEqual([
      {
        op: "lt",
        col: "occurred_at",
        value: new Date(NOW - 7 * 86_400_000).toISOString(),
        extra: undefined,
      },
    ]);
  });

  it("counts failures under the threshold without paging", async () => {
    seedFailures(2);

    const { body } = await callCron<AlertBody>(Route, PATH);

    expect(body).toMatchObject({ checked: 2, fired: [] });
    expect(writesTo(fake, "inserts", "folder_write_alerts")).toStrictEqual([]);
  });

  it("ignores failures older than the 15-minute window", async () => {
    fake.seed("folder_write_failures", [
      {
        error_code: "42703",
        folder_id: FOLDER_ID,
        occurred_at: new Date(NOW - MINUTE).toISOString(),
      },
      {
        error_code: "42703",
        folder_id: FOLDER_ID,
        occurred_at: new Date(NOW - 16 * MINUTE).toISOString(),
      },
      {
        error_code: "42703",
        folder_id: FOLDER_ID,
        occurred_at: new Date(NOW - 60 * MINUTE).toISOString(),
      },
    ]);

    const { body } = await callCron<AlertBody>(Route, PATH);

    expect(body).toMatchObject({ checked: 1, fired: [] });
  });

  it("caps the failure query so one bad hour cannot pull the whole table", async () => {
    await callCron<AlertBody>(Route, PATH);

    const select = fake.calls.selects.find((s) => s.table === "folder_write_failures");
    expect(select?.limit).toBe(5000);
    expect(select?.filters).toStrictEqual([
      {
        op: "gte",
        col: "occurred_at",
        value: new Date(NOW - 15 * MINUTE).toISOString(),
        extra: undefined,
      },
    ]);
  });
});

describe("firing an alert", () => {
  it("records the spike and reports it in the body", async () => {
    seedFailures(3);

    const { status, body } = await callCron<AlertBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      checked: 3,
      fired: [{ error_code: "42703", folder_id: FOLDER_ID, failure_count: 3 }],
    });
    expect(writesTo(fake, "inserts", "folder_write_alerts").map((w) => w.payload)).toStrictEqual([
      [{ error_code: "42703", folder_id: FOLDER_ID, failure_count: 3, window_minutes: 15 }],
    ]);
  });

  it("groups a missing error code under `unknown` rather than dropping it", async () => {
    seedFailures(3, { error_code: null });

    const { body } = await callCron<AlertBody>(Route, PATH);

    expect(body.fired).toStrictEqual([
      { error_code: "unknown", folder_id: FOLDER_ID, failure_count: 3 },
    ]);
  });

  it("fires one alert per (error_code, folder_id) group", async () => {
    fake.seed("folder_write_failures", [
      ...Array.from({ length: 3 }, () => ({
        error_code: "42703",
        folder_id: FOLDER_ID,
        occurred_at: new Date(NOW - MINUTE).toISOString(),
      })),
      ...Array.from({ length: 3 }, () => ({
        error_code: "40001",
        folder_id: null,
        occurred_at: new Date(NOW - MINUTE).toISOString(),
      })),
      // Under threshold — must not be paged alongside the others.
      { error_code: "23505", folder_id: FOLDER_ID, occurred_at: new Date(NOW).toISOString() },
    ]);

    const { body } = await callCron<AlertBody>(Route, PATH);

    expect(body.fired?.map((f) => f.error_code).sort()).toStrictEqual(["40001", "42703"]);
  });

  it("posts a compact page to ALERT_WEBHOOK_URL when one is configured", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.test/page");
    seedFailures(3);

    await callCron<AlertBody>(Route, PATH);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.test/page");
    expect(init.method).toBe("POST");
    expect(init.headers).toStrictEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toStrictEqual({
      text:
        `🚨 folder_example_write failures spiking (last 15m, run ${RUN_ID})\n` +
        `• error_code=42703 folder_id=${FOLDER_ID} count=3 (last ${new Date(NOW - MINUTE).toISOString()})`,
    });
  });

  it("still returns 200 when the paging webhook itself fails", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.test/page");
    fetchMock.mockRejectedValue(new Error("webhook unreachable"));
    seedFailures(3);

    const { status, body } = await callCron<AlertBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body.fired).toHaveLength(1);
    // The durable alert row is written before the page is attempted, so the
    // incident is still recorded when the webhook is down.
    expect(writesTo(fake, "inserts", "folder_write_alerts")).toHaveLength(1);
  });
});

describe("cooldown", () => {
  it("suppresses a group already paged inside the 30-minute cooldown", async () => {
    seedFailures(3);
    fake.seed("folder_write_alerts", [
      {
        error_code: "42703",
        folder_id: FOLDER_ID,
        fired_at: new Date(NOW - 20 * MINUTE).toISOString(),
      },
    ]);

    const { body } = await callCron<AlertBody>(Route, PATH);

    expect(body).toMatchObject({ checked: 3, fired: [] });
    expect(writesTo(fake, "inserts", "folder_write_alerts")).toStrictEqual([]);
  });

  it("pages again once the cooldown has elapsed", async () => {
    seedFailures(3);
    fake.seed("folder_write_alerts", [
      {
        error_code: "42703",
        folder_id: FOLDER_ID,
        fired_at: new Date(NOW - 31 * MINUTE).toISOString(),
      },
    ]);

    const { body } = await callCron<AlertBody>(Route, PATH);

    // The cooldown query itself only fetches the last 30 minutes, so a row
    // this old is not even a candidate for suppression.
    expect(body.fired).toHaveLength(1);
  });

  it("does not let a different group's recent page mute this one", async () => {
    seedFailures(3);
    fake.seed("folder_write_alerts", [
      { error_code: "40001", folder_id: FOLDER_ID, fired_at: new Date(NOW - MINUTE).toISOString() },
    ]);

    const { body } = await callCron<AlertBody>(Route, PATH);

    expect(body.fired).toHaveLength(1);
  });
});

describe("failure handling", () => {
  it("returns 500 and writes nothing when the failure query fails", async () => {
    fake.onSelect("folder_write_failures", () => ({ message: "relation does not exist" }));

    const { status, body } = await callCron<AlertBody>(Route, PATH);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "relation does not exist" });
    expect(writeCount(fake)).toBe(0);
  });

  it("returns 500 rather than paging blind when the cooldown query fails", async () => {
    seedFailures(3);
    fake.onSelect("folder_write_alerts", () => ({ message: "permission denied" }));

    const { status, body } = await callCron<AlertBody>(Route, PATH);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "permission denied" });
    expect(writeCount(fake)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers GET with 405 rather than evaluating alerts", async () => {
    const res = await handler(Route, "GET")({ request: cronRequest(PATH), params: {} });

    expect(res.status).toBe(405);
    expect(fake.calls.selects).toStrictEqual([]);
  });
});
