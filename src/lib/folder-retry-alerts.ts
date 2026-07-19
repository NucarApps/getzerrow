// Pure alert-rule logic for elevated folder_example_write RETRY rates.
//
// Kept free of Supabase imports so it stays unit-testable: the cron endpoint
// (check-folder-retry-alerts) fetches recent retry rows + recently-fired retry
// alerts, hands them here, and acts on the returned groups.
//
// Why retries (not just failures)? A write that fails transiently and then
// succeeds on retry produces NO failure record — folder learning still works,
// so the failure-spike alert stays silent. But a rising retry rate is the
// leading indicator that the database is getting flaky; catching it lets us
// react before retries exhaust and learning fully stops. This module detects a
// spike of retried writes per folder and applies a cooldown so we page once
// per incident instead of on every tick.

/** A single folder_example_write that needed more than one attempt. */
export type RetryRow = {
  folder_id: string | null;
  occurred_at: string;
  attempts: number;
  outcome: string;
};

/** A retry alert previously fired for a folder, used for cooldown de-dup. */
export type RecentRetryAlert = {
  folder_id: string | null;
  fired_at: string;
};

/** An aggregated retry spike for one folder. */
export type RetryAlertGroup = {
  folder_id: string | null;
  /** Number of retried writes in the window. */
  retry_count: number;
  /** Subset of retry_count whose final outcome was still a failure. */
  failed_count: number;
  /** Largest attempt count seen in the window (severity hint). */
  max_attempts: number;
  first_at: string;
  last_at: string;
};

export type EvaluateRetryConfig = {
  /** Minimum retried writes for one folder in the window before it's a spike. */
  threshold: number;
  /** Don't re-fire the same folder within this many minutes. */
  cooldownMinutes: number;
  /** Current time in ms (injectable for tests). */
  now: number;
};

function groupKey(folderId: string | null): string {
  return folderId ?? "null";
}

/** Aggregate raw retry rows into per-folder counts, sorted by count desc. */
export function groupRetries(rows: RetryRow[]): RetryAlertGroup[] {
  const byKey = new Map<string, RetryAlertGroup>();
  for (const row of rows) {
    const folderId = row.folder_id ?? null;
    const key = groupKey(folderId);
    const attempts = Number.isFinite(row.attempts) ? row.attempts : 0;
    const failed = row.outcome === "failure" ? 1 : 0;
    const existing = byKey.get(key);
    if (existing) {
      existing.retry_count += 1;
      existing.failed_count += failed;
      if (attempts > existing.max_attempts) existing.max_attempts = attempts;
      if (row.occurred_at < existing.first_at) existing.first_at = row.occurred_at;
      if (row.occurred_at > existing.last_at) existing.last_at = row.occurred_at;
    } else {
      byKey.set(key, {
        folder_id: folderId,
        retry_count: 1,
        failed_count: failed,
        max_attempts: attempts,
        first_at: row.occurred_at,
        last_at: row.occurred_at,
      });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.retry_count - a.retry_count);
}

/**
 * Decide which spiking folders should page right now: at or over threshold AND
 * not already alerted within the cooldown window.
 */
export function selectRetryAlertsToFire(
  groups: RetryAlertGroup[],
  recentAlerts: RecentRetryAlert[],
  config: EvaluateRetryConfig,
): RetryAlertGroup[] {
  const cooldownMs = config.cooldownMinutes * 60_000;
  const suppressed = new Set<string>();
  for (const alert of recentAlerts) {
    const firedMs = Date.parse(alert.fired_at);
    if (Number.isNaN(firedMs)) continue;
    if (config.now - firedMs < cooldownMs) {
      suppressed.add(groupKey(alert.folder_id ?? null));
    }
  }
  return groups.filter(
    (g) => g.retry_count >= config.threshold && !suppressed.has(groupKey(g.folder_id)),
  );
}

/** Convenience: group then select in one call. */
export function evaluateFolderRetryAlerts(
  rows: RetryRow[],
  recentAlerts: RecentRetryAlert[],
  config: EvaluateRetryConfig,
): RetryAlertGroup[] {
  return selectRetryAlertsToFire(groupRetries(rows), recentAlerts, config);
}
