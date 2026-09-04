// Unit tests for the structured metric logger used to alert on folder-learning
// write failures. We assert the emitted JSON shape stays stable, because
// log-based alerts filter on these exact fields (scope, metric, outcome,
// error_code).
import { describe, it, expect, vi, afterEach } from "vitest";
import { logMetric, withCronRun } from "./log.server";

afterEach(() => {
  vi.restoreAllMocks();
});

function captureLog(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  fn();
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>;
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

// `cron.<name>.end` is what operators read to tell a good run from a bad one,
// and cron_watchdog reasons over the pubsub_events these handlers write. Both
// of the behaviors below were previously wrong.
describe("withCronRun", () => {
  function captureLines(): { lines: Record<string, unknown>[]; restore: () => void } {
    const lines: Record<string, unknown>[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((s) => {
      lines.push(JSON.parse(s as string));
    });
    const err = vi.spyOn(console, "error").mockImplementation((s) => {
      lines.push(JSON.parse(s as string));
    });
    return {
      lines,
      restore: () => {
        log.mockRestore();
        err.mockRestore();
      },
    };
  }

  const endLine = (lines: Record<string, unknown>[]) =>
    lines.find((l) => String(l.scope ?? "").endsWith(".end"));

  /** A real v4 uuid, not merely a non-empty string. */
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("logs ok:true and the status for a successful run", async () => {
    const { lines, restore } = captureLines();
    try {
      const res = await withCronRun("demo", async () => Response.json({ ok: true }));
      expect(res.status).toBe(200);
    } finally {
      restore();
    }
    expect(endLine(lines)).toMatchObject({ ok: true, status: 200 });
  });

  // The bug: routes signal failure by RETURNING an early 500, not by throwing,
  // so every one of those runs was logged as a success.
  it("logs ok:false when the handler RETURNS an error status", async () => {
    const { lines, restore } = captureLines();
    try {
      const res = await withCronRun("demo", async () =>
        Response.json({ error: "query failed" }, { status: 500 }),
      );
      expect(res.status).toBe(500);
    } finally {
      restore();
    }
    expect(endLine(lines)).toMatchObject({ ok: false, status: 500 });
  });

  it("threads one uuid run_id through the handler and both log lines", async () => {
    // The run id is how an operator ties a cron run's start line, end line
    // and error response together. `toBeTruthy` would accept "x" — and
    // two DIFFERENT truthy ids would satisfy it just as well, which is
    // the failure that would actually hurt.
    const { lines, restore } = captureLines();
    let seen = "";
    try {
      await withCronRun("demo", async ({ runId }) => {
        seen = runId;
        return Response.json({ ok: true });
      });
    } finally {
      restore();
    }
    expect(seen).toMatch(UUID);
    expect(endLine(lines)).toMatchObject({ run_id: seen });
    // Every line the run emitted carries the same id.
    const ids = new Set(lines.map((l) => l.run_id).filter(Boolean));
    expect(ids).toEqual(new Set([seen]));
  });

  // The bug: withCronRun rethrew, and 14 of the 21 wrapped routes have no outer
  // try/catch, so an unexpected throw reached the framework as a non-JSON 500.
  it("converts an escaped throw into a JSON 500 instead of propagating", async () => {
    const { lines, restore } = captureLines();
    let res: Response;
    try {
      res = await withCronRun("demo", async () => {
        throw new Error("kaboom");
      });
    } finally {
      restore();
    }
    expect(res!.status).toBe(500);
    expect(await res!.json()).toMatchObject({ ok: false, error: "kaboom" });
    expect(lines.some((l) => String(l.scope ?? "").endsWith(".crash"))).toBe(true);
  });

  it("includes run_id in the generated error response", async () => {
    const { restore } = captureLines();
    let res: Response;
    try {
      res = await withCronRun("demo", async () => {
        throw new Error("kaboom");
      });
    } finally {
      restore();
    }
    // An operator reads this id off the 500 and greps the logs for it, so
    // it has to be the real one rather than merely present.
    expect((await res!.json()).run_id).toMatch(UUID);
  });

  it("truncates a huge error message", async () => {
    const { restore } = captureLines();
    let res: Response;
    try {
      res = await withCronRun("demo", async () => {
        throw new Error("x".repeat(5000));
      });
    } finally {
      restore();
    }
    expect(((await res!.json()).error as string).length).toBe(500);
  });
});
