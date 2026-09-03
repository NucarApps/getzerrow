// Contract for the folder_example_write RETRY-rate alert hook. Same three
// moving parts as its failure-spike sibling — alert row, webhook page,
// retention delete — but grouped by folder alone, and carrying the severity
// hints (failed_count, max_attempts) that a retry spike is worth paging on.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeSupabaseFake,
  mockSupabaseAdmin,
  writeCount,
  writesTo,
} from "@/lib/__fixtures__/supabase-fake";
import { CRON_SECRET, callCron, cronRequest, handler } from "../__fixtures__/route-harness";
import { Route } from "./check-folder-retry-alerts";

const fake = makeSupabaseFake();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: mockSupabaseAdmin(() => fake),
}));

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOLDER_ID = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;
const PATH = "hooks/check-folder-retry-alerts";

type RetryAlertBody = {
  ok?: boolean;
  checked?: number;
  window_minutes?: number;
  threshold?: number;
  fired?: Array<{
    folder_id: string | null;
    retry_count: number;
    failed_count: number;
    max_attempts: number;
  }>;
  run_id?: string;
  error?: string;
};

let fetchMock: ReturnType<typeof vi.fn>;

function retryRow(over: Record<string, unknown> = {}) {
  return {
    folder_id: FOLDER_ID,
    occurred_at: new Date(NOW - MINUTE).toISOString(),
    attempts: 2,
    outcome: "success",
    ...over,
  };
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
  it("reports nothing fired and still prunes the retry log", async () => {
    const { status, body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toStrictEqual({
      ok: true,
      checked: 0,
      window_minutes: 15,
      threshold: 3,
      fired: [],
      run_id: RUN_ID,
    });
    expect(writesTo(fake, "deletes", "folder_write_retries")[0]?.filters).toStrictEqual([
      {
        op: "lt",
        col: "occurred_at",
        value: new Date(NOW - 7 * 86_400_000).toISOString(),
        extra: undefined,
      },
    ]);
  });

  it("counts retries under the threshold without paging", async () => {
    fake.seed("folder_write_retries", [retryRow(), retryRow()]);

    const { body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(body).toMatchObject({ checked: 2, fired: [] });
    expect(writesTo(fake, "inserts", "folder_retry_alerts")).toStrictEqual([]);
  });

  it("ignores retries older than the 15-minute window and caps the query", async () => {
    fake.seed("folder_write_retries", [
      retryRow(),
      retryRow({ occurred_at: new Date(NOW - 16 * MINUTE).toISOString() }),
    ]);

    const { body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(body).toMatchObject({ checked: 1 });
    const select = fake.calls.selects.find((s) => s.table === "folder_write_retries");
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
  it("records the spike with its severity hints", async () => {
    fake.seed("folder_write_retries", [
      retryRow({ attempts: 2 }),
      retryRow({ attempts: 4, outcome: "failure" }),
      retryRow({ attempts: 3 }),
    ]);

    const { status, body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      checked: 3,
      fired: [{ folder_id: FOLDER_ID, retry_count: 3, failed_count: 1, max_attempts: 4 }],
    });
    // The persisted row carries only what the cooldown needs; the severity
    // hints live in the page and the response.
    expect(writesTo(fake, "inserts", "folder_retry_alerts").map((w) => w.payload)).toStrictEqual([
      [{ folder_id: FOLDER_ID, retry_count: 3, window_minutes: 15 }],
    ]);
  });

  it("groups retries with no folder under a single null group", async () => {
    fake.seed("folder_write_retries", [
      retryRow({ folder_id: null }),
      retryRow({ folder_id: null }),
      retryRow({ folder_id: null }),
    ]);

    const { body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(body.fired).toStrictEqual([
      { folder_id: null, retry_count: 3, failed_count: 0, max_attempts: 2 },
    ]);
  });

  it("posts a compact page to ALERT_WEBHOOK_URL when one is configured", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.test/page");
    fake.seed("folder_write_retries", [retryRow(), retryRow(), retryRow()]);

    await callCron<RetryAlertBody>(Route, PATH);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.test/page");
    expect(JSON.parse(String(init.body))).toStrictEqual({
      text:
        `⚠️ folder_example_write retry rate elevated (last 15m, run ${RUN_ID})\n` +
        `• folder_id=${FOLDER_ID} retries=3 failed=0 max_attempts=2 (last ${new Date(NOW - MINUTE).toISOString()})`,
    });
  });

  it("does not page when no webhook is configured, but still records the alert", async () => {
    fake.seed("folder_write_retries", [retryRow(), retryRow(), retryRow()]);

    await callCron<RetryAlertBody>(Route, PATH);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writesTo(fake, "inserts", "folder_retry_alerts")).toHaveLength(1);
  });

  it("still returns 200 when the paging webhook fails", async () => {
    vi.stubEnv("ALERT_WEBHOOK_URL", "https://hooks.test/page");
    fetchMock.mockRejectedValue(new Error("webhook unreachable"));
    fake.seed("folder_write_retries", [retryRow(), retryRow(), retryRow()]);

    const { status, body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(status).toBe(200);
    expect(body.fired).toHaveLength(1);
  });
});

describe("cooldown", () => {
  it("suppresses a folder already paged inside the 30-minute cooldown", async () => {
    fake.seed("folder_write_retries", [retryRow(), retryRow(), retryRow()]);
    fake.seed("folder_retry_alerts", [
      { folder_id: FOLDER_ID, fired_at: new Date(NOW - 20 * MINUTE).toISOString() },
    ]);

    const { body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(body).toMatchObject({ checked: 3, fired: [] });
    expect(writesTo(fake, "inserts", "folder_retry_alerts")).toStrictEqual([]);
  });

  it("pages again once the cooldown has elapsed", async () => {
    fake.seed("folder_write_retries", [retryRow(), retryRow(), retryRow()]);
    fake.seed("folder_retry_alerts", [
      { folder_id: FOLDER_ID, fired_at: new Date(NOW - 31 * MINUTE).toISOString() },
    ]);

    const { body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(body.fired).toHaveLength(1);
  });
});

describe("failure handling", () => {
  it("returns 500 and writes nothing when the retry query fails", async () => {
    fake.onSelect("folder_write_retries", () => ({ message: "relation does not exist" }));

    const { status, body } = await callCron<RetryAlertBody>(Route, PATH);

    expect(status).toBe(500);
    expect(body).toStrictEqual({ error: "relation does not exist" });
    expect(writeCount(fake)).toBe(0);
  });

  it("returns 500 rather than paging blind when the cooldown query fails", async () => {
    fake.seed("folder_write_retries", [retryRow(), retryRow(), retryRow()]);
    fake.onSelect("folder_retry_alerts", () => ({ message: "permission denied" }));

    const { status, body } = await callCron<RetryAlertBody>(Route, PATH);

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
