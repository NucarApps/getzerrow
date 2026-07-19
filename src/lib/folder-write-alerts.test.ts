import { describe, it, expect } from "vitest";
import {
  groupFailures,
  selectAlertsToFire,
  evaluateFolderWriteAlerts,
  normalizeErrorCode,
  type FailureRow,
  type RecentAlert,
} from "./folder-write-alerts";

const T0 = Date.parse("2026-07-03T10:00:00.000Z");

function fail(error_code: string | null, folder_id: string | null, minute: number): FailureRow {
  return {
    error_code,
    folder_id,
    occurred_at: new Date(T0 + minute * 60_000).toISOString(),
  };
}

describe("normalizeErrorCode", () => {
  it("falls back to 'unknown' for empty/null codes", () => {
    expect(normalizeErrorCode(null)).toBe("unknown");
    expect(normalizeErrorCode(undefined)).toBe("unknown");
    expect(normalizeErrorCode("  ")).toBe("unknown");
    expect(normalizeErrorCode("42703")).toBe("42703");
  });
});

describe("groupFailures", () => {
  it("aggregates by (error_code, folder_id) with counts and time bounds", () => {
    const rows = [
      fail("42703", "folder-a", 0),
      fail("42703", "folder-a", 3),
      fail("42703", "folder-b", 1),
      fail("23505", "folder-a", 2),
    ];
    const groups = groupFailures(rows);
    const a42703 = groups.find((g) => g.error_code === "42703" && g.folder_id === "folder-a");
    expect(a42703?.failure_count).toBe(2);
    expect(a42703?.first_at).toBe(new Date(T0).toISOString());
    expect(a42703?.last_at).toBe(new Date(T0 + 3 * 60_000).toISOString());
    // sorted by count desc → the 2-count group is first
    expect(groups[0].failure_count).toBe(2);
  });

  it("treats missing error codes as 'unknown'", () => {
    const groups = groupFailures([fail(null, "folder-a", 0), fail("", "folder-a", 1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].error_code).toBe("unknown");
    expect(groups[0].failure_count).toBe(2);
  });
});

describe("selectAlertsToFire", () => {
  const config = { threshold: 3, cooldownMinutes: 30, now: T0 + 5 * 60_000 };

  it("fires groups at or over threshold", () => {
    const groups = groupFailures([
      fail("42703", "folder-a", 0),
      fail("42703", "folder-a", 1),
      fail("42703", "folder-a", 2),
      fail("23505", "folder-b", 0),
    ]);
    const fired = selectAlertsToFire(groups, [], config);
    expect(fired).toHaveLength(1);
    expect(fired[0].error_code).toBe("42703");
    expect(fired[0].folder_id).toBe("folder-a");
  });

  it("suppresses groups within the cooldown window", () => {
    const groups = groupFailures([
      fail("42703", "folder-a", 0),
      fail("42703", "folder-a", 1),
      fail("42703", "folder-a", 2),
    ]);
    const recent: RecentAlert[] = [
      { error_code: "42703", folder_id: "folder-a", fired_at: new Date(T0).toISOString() },
    ];
    expect(selectAlertsToFire(groups, recent, config)).toHaveLength(0);
  });

  it("re-fires once the cooldown has elapsed", () => {
    const groups = groupFailures([
      fail("42703", "folder-a", 0),
      fail("42703", "folder-a", 1),
      fail("42703", "folder-a", 2),
    ]);
    const recent: RecentAlert[] = [
      {
        error_code: "42703",
        folder_id: "folder-a",
        fired_at: new Date(T0 - 40 * 60_000).toISOString(),
      },
    ];
    expect(selectAlertsToFire(groups, recent, config)).toHaveLength(1);
  });

  it("does not fire groups below threshold", () => {
    const groups = groupFailures([fail("42703", "folder-a", 0), fail("42703", "folder-a", 1)]);
    expect(selectAlertsToFire(groups, [], config)).toHaveLength(0);
  });
});

describe("evaluateFolderWriteAlerts", () => {
  it("groups and selects in one pass", () => {
    const rows = [
      fail("42703", "folder-a", 0),
      fail("42703", "folder-a", 1),
      fail("42703", "folder-a", 2),
    ];
    const fired = evaluateFolderWriteAlerts(rows, [], {
      threshold: 3,
      cooldownMinutes: 30,
      now: T0 + 5 * 60_000,
    });
    expect(fired).toHaveLength(1);
  });
});
