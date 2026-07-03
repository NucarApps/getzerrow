// Unit tests for the structured metric logger used to alert on folder-learning
// write failures. We assert the emitted JSON shape stays stable, because
// log-based alerts filter on these exact fields (scope, metric, outcome,
// error_code).
import { describe, it, expect, vi, afterEach } from "vitest";
import { logMetric } from "./log.server";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLog(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  fn();
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
}

describe("logMetric", () => {
  it("emits a single info line with a stable metric envelope", () => {
    const payload = captureLog(() =>
      logMetric("folder_example_write", { outcome: "success", folder_id: "f1" }),
    );
    expect(payload.level).toBe("info");
    expect(payload.scope).toBe("metric");
    expect(payload.metric).toBe("folder_example_write");
    expect(payload.outcome).toBe("success");
    expect(payload.folder_id).toBe("f1");
    expect(typeof payload.ts).toBe("string");
  });

  it("carries the Postgres error_code on failure so alerts can group by it", () => {
    const payload = captureLog(() =>
      logMetric("folder_example_write", {
        outcome: "failure",
        error_code: "42703",
        folder_id: "f2",
        duration_ms: 12,
      }),
    );
    expect(payload.outcome).toBe("failure");
    expect(payload.error_code).toBe("42703");
    expect(payload.duration_ms).toBe(12);
  });

  it("works with no extra fields", () => {
    const payload = captureLog(() => logMetric("some_metric"));
    expect(payload.metric).toBe("some_metric");
    expect(payload.scope).toBe("metric");
  });
});
