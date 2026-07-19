import { describe, it, expect } from "vitest";
import {
  groupRetries,
  selectRetryAlertsToFire,
  evaluateFolderRetryAlerts,
  type RetryRow,
  type RecentRetryAlert,
} from "./folder-retry-alerts";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

describe("groupRetries", () => {
  it("aggregates retried writes per folder with counts and severity", () => {
    const rows: RetryRow[] = [
      { folder_id: "f1", occurred_at: iso(1), attempts: 2, outcome: "success" },
      { folder_id: "f1", occurred_at: iso(3), attempts: 3, outcome: "failure" },
      { folder_id: "f2", occurred_at: iso(2), attempts: 2, outcome: "success" },
    ];
    const groups = groupRetries(rows);
    expect(groups).toHaveLength(2);
    const f1 = groups.find((g) => g.folder_id === "f1")!;
    expect(f1.retry_count).toBe(2);
    expect(f1.failed_count).toBe(1);
    expect(f1.max_attempts).toBe(3);
    expect(f1.first_at).toBe(iso(3));
    expect(f1.last_at).toBe(iso(1));
  });

  it("sorts groups by retry_count descending", () => {
    const rows: RetryRow[] = [
      { folder_id: "low", occurred_at: iso(1), attempts: 2, outcome: "success" },
      { folder_id: "high", occurred_at: iso(1), attempts: 2, outcome: "success" },
      { folder_id: "high", occurred_at: iso(2), attempts: 2, outcome: "success" },
    ];
    expect(groupRetries(rows).map((g) => g.folder_id)).toEqual(["high", "low"]);
  });

  it("buckets null folder_id together", () => {
    const rows: RetryRow[] = [
      { folder_id: null, occurred_at: iso(1), attempts: 2, outcome: "success" },
      { folder_id: null, occurred_at: iso(2), attempts: 2, outcome: "failure" },
    ];
    const groups = groupRetries(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].folder_id).toBeNull();
    expect(groups[0].retry_count).toBe(2);
  });
});

describe("selectRetryAlertsToFire", () => {
  const config = { threshold: 3, cooldownMinutes: 30, now: NOW };

  it("fires folders at or over threshold", () => {
    const rows: RetryRow[] = Array.from({ length: 3 }, (_, i) => ({
      folder_id: "f1",
      occurred_at: iso(i + 1),
      attempts: 2,
      outcome: "success",
    }));
    const fired = evaluateFolderRetryAlerts(rows, [], config);
    expect(fired).toHaveLength(1);
    expect(fired[0].folder_id).toBe("f1");
  });

  it("does not fire below threshold", () => {
    const rows: RetryRow[] = [
      { folder_id: "f1", occurred_at: iso(1), attempts: 2, outcome: "success" },
      { folder_id: "f1", occurred_at: iso(2), attempts: 2, outcome: "success" },
    ];
    expect(evaluateFolderRetryAlerts(rows, [], config)).toHaveLength(0);
  });

  it("suppresses a folder alerted within the cooldown window", () => {
    const groups = groupRetries(
      Array.from({ length: 4 }, (_, i) => ({
        folder_id: "f1",
        occurred_at: iso(i + 1),
        attempts: 2,
        outcome: "success" as const,
      })),
    );
    const recent: RecentRetryAlert[] = [{ folder_id: "f1", fired_at: iso(10) }];
    expect(selectRetryAlertsToFire(groups, recent, config)).toHaveLength(0);
  });

  it("re-fires once the cooldown has elapsed", () => {
    const groups = groupRetries(
      Array.from({ length: 4 }, (_, i) => ({
        folder_id: "f1",
        occurred_at: iso(i + 1),
        attempts: 2,
        outcome: "success" as const,
      })),
    );
    const recent: RecentRetryAlert[] = [{ folder_id: "f1", fired_at: iso(45) }];
    expect(selectRetryAlertsToFire(groups, recent, config)).toHaveLength(1);
  });
});
