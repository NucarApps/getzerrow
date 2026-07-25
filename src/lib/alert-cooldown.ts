// Shared threshold + cooldown rule for the folder_example_write alerts.
//
// folder-write-alerts (failure spikes) and folder-retry-alerts (retry-rate
// spikes) group by different keys and count different fields, so their
// aggregation stays separate. What was identical between them — the config
// shape and the "over threshold AND not already paged recently" decision — is
// here, so a change to the paging rule can't land in only one of them.

export type AlertCooldownConfig = {
  /** Minimum occurrences inside the window before a group is considered spiking. */
  threshold: number;
  /** Don't re-fire the same group within this many minutes. */
  cooldownMinutes: number;
  /** Current time in ms (injectable for tests). */
  now: number;
};

/**
 * Filter `groups` down to the ones that should page now.
 *
 * `keyOf` derives a group's identity, `recentKeyOf` derives the same identity
 * from a previously-fired alert row, and `countOf` reads whichever count the
 * caller thresholds on. An alert row with an unparseable `fired_at` is ignored
 * rather than treated as "just fired", so bad data can't silently mute paging.
 */
export function selectByThresholdWithCooldown<TGroup, TAlert extends { fired_at: string }>(
  groups: TGroup[],
  recentAlerts: TAlert[],
  config: AlertCooldownConfig,
  opts: {
    keyOf: (group: TGroup) => string;
    recentKeyOf: (alert: TAlert) => string;
    countOf: (group: TGroup) => number;
  },
): TGroup[] {
  const cooldownMs = config.cooldownMinutes * 60_000;
  const suppressed = new Set<string>();
  for (const alert of recentAlerts) {
    const firedMs = Date.parse(alert.fired_at);
    if (Number.isNaN(firedMs)) continue;
    if (config.now - firedMs < cooldownMs) suppressed.add(opts.recentKeyOf(alert));
  }
  return groups.filter(
    (g) => opts.countOf(g) >= config.threshold && !suppressed.has(opts.keyOf(g)),
  );
}
