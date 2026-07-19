// Pure alert-rule logic for folder_example_write failure spikes.
//
// Kept free of Supabase imports so it stays unit-testable: the cron endpoint
// (check-folder-write-alerts) fetches recent failure rows + recently-fired
// alerts, hands them here, and acts on the returned groups. When learning
// stops persisting examples, failures cluster by (error_code, folder_id) —
// this module detects a spike per group and applies a cooldown so we page
// once per incident instead of on every tick.

/** A single folder_example_write failure recorded in the durable log. */
export type FailureRow = {
  error_code: string | null;
  folder_id: string | null;
  occurred_at: string;
};

/** An alert previously fired for a group, used for cooldown de-duplication. */
export type RecentAlert = {
  error_code: string;
  folder_id: string | null;
  fired_at: string;
};

/** An aggregated failure spike for one (error_code, folder_id) group. */
export type AlertGroup = {
  error_code: string;
  folder_id: string | null;
  failure_count: number;
  first_at: string;
  last_at: string;
};

export type EvaluateConfig = {
  /** Minimum failures inside the window before a group is considered spiking. */
  threshold: number;
  /** Don't re-fire the same group within this many minutes. */
  cooldownMinutes: number;
  /** Current time in ms (injectable for tests). */
  now: number;
};

/** Normalize a possibly-missing error code so grouping is stable. */
export function normalizeErrorCode(code: string | null | undefined): string {
  const trimmed = (code ?? "").trim();
  return trimmed.length > 0 ? trimmed : "unknown";
}

function groupKey(errorCode: string, folderId: string | null): string {
  return `${errorCode}::${folderId ?? "null"}`;
}

/** Aggregate raw failure rows into per-group counts, sorted by count desc. */
export function groupFailures(rows: FailureRow[]): AlertGroup[] {
  const byKey = new Map<string, AlertGroup>();
  for (const row of rows) {
    const errorCode = normalizeErrorCode(row.error_code);
    const folderId = row.folder_id ?? null;
    const key = groupKey(errorCode, folderId);
    const existing = byKey.get(key);
    if (existing) {
      existing.failure_count += 1;
      if (row.occurred_at < existing.first_at) existing.first_at = row.occurred_at;
      if (row.occurred_at > existing.last_at) existing.last_at = row.occurred_at;
    } else {
      byKey.set(key, {
        error_code: errorCode,
        folder_id: folderId,
        failure_count: 1,
        first_at: row.occurred_at,
        last_at: row.occurred_at,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.failure_count - a.failure_count);
}

/**
 * Decide which spiking groups should page right now: over threshold AND not
 * already alerted within the cooldown window.
 */
export function selectAlertsToFire(
  groups: AlertGroup[],
  recentAlerts: RecentAlert[],
  config: EvaluateConfig,
): AlertGroup[] {
  const cooldownMs = config.cooldownMinutes * 60_000;
  const suppressed = new Set<string>();
  for (const alert of recentAlerts) {
    const firedMs = Date.parse(alert.fired_at);
    if (Number.isNaN(firedMs)) continue;
    if (config.now - firedMs < cooldownMs) {
      suppressed.add(groupKey(normalizeErrorCode(alert.error_code), alert.folder_id ?? null));
    }
  }
  return groups.filter(
    (g) =>
      g.failure_count >= config.threshold && !suppressed.has(groupKey(g.error_code, g.folder_id)),
  );
}

/** Convenience: group then select in one call. */
export function evaluateFolderWriteAlerts(
  rows: FailureRow[],
  recentAlerts: RecentAlert[],
  config: EvaluateConfig,
): AlertGroup[] {
  return selectAlertsToFire(groupFailures(rows), recentAlerts, config);
}
