// The Pub/Sub health diagnosis shown at the top of the push-activity panel.
//
// This is the operator-facing answer to "why is mail not arriving?", and it
// is a strict severity ladder: the first rung that matches wins, so a single
// banner replaces what would otherwise be a stack of overlapping warnings.
// The rendering lives in the component; only the diagnosis lives here, so
// every rung and every boundary between rungs can be table-tested in node.
//
// `now` is a parameter rather than a `Date.now()` call so the age boundaries
// (10 minutes of push silence, 60 seconds since a watch re-arm) are testable.

/** The subset of the `listPubsubEvents` stats block the ladder reads. */
export type PubsubHealthStats = {
  push24: number;
  poll24: number;
  synced24: number;
  pushUnmatched24?: number | null;
  lastPushAt?: string | null;
  lastPollAt?: string | null;
};

/** The most recent push/poll event row, whatever its `event_type`. */
export type PubsubHealthPush = {
  received_at: string;
  event_type: string;
  accounts_matched?: number | null;
  email_address?: string | null;
};

/** The most recent watch-renewal event row. */
export type PubsubHealthRenew = { received_at: string };

export type PubsubHealthInput = {
  stats: PubsubHealthStats | undefined;
  lastPush: PubsubHealthPush | null;
  lastRenew: PubsubHealthRenew | null;
  watchActive: boolean;
  /** Milliseconds since the epoch, as `Date.now()` would return. */
  now: number;
};

/**
 * One rung of the ladder. `code` identifies the rung (the component maps it
 * to copy); the extra fields are the numbers that copy interpolates, so the
 * renderer never has to re-derive anything the ladder already computed.
 */
export type PubsubHealth =
  | { kind: "danger"; code: "push-unmatched"; emailAddress: string | null }
  | { kind: "danger"; code: "watch-armed-no-push"; renewedAt: string }
  | { kind: "danger"; code: "no-push-24h"; poll24: number; synced24: number }
  | { kind: "warn"; code: "poll-stalled"; pollSilentMin: number | null }
  | { kind: "warn"; code: "total-silence" }
  | { kind: "success"; code: "push-healthy"; push24: number; lastPushAt: string }
  | { kind: "info"; code: "poll-fallback"; poll24: number; synced24: number };

/** A push older than this (or older than the last re-arm) is not evidence. */
const PUSH_STALE_MIN = 10;
/** Grace period after a watch re-arm before "no push since" is alarming. */
const RENEW_GRACE_MS = 60_000;
/** The fallback poll runs every 2 minutes; this much silence means stalled. */
const POLL_STALE_MIN = 10;

export function derivePubsubHealth({
  stats,
  lastPush,
  lastRenew,
  watchActive,
  now,
}: PubsubHealthInput): PubsubHealth | null {
  const lastPushMs = lastPush ? new Date(lastPush.received_at).getTime() : 0;
  const lastRenewMs = lastRenew ? new Date(lastRenew.received_at).getTime() : 0;
  const lastPushAgeMin = lastPush ? Math.floor((now - lastPushMs) / 60000) : null;
  const lastPushStale =
    lastPush &&
    lastPushAgeMin !== null &&
    (lastPushAgeMin >= PUSH_STALE_MIN || lastPushMs < lastRenewMs);

  // Severity order — first match wins.

  // RED: push received but didn't match an account.
  if (
    lastPush &&
    !lastPushStale &&
    lastPush.event_type === "push" &&
    (lastPush.accounts_matched ?? 0) === 0
  ) {
    return { kind: "danger", code: "push-unmatched", emailAddress: lastPush.email_address ?? null };
  }

  // RED: watch armed but no real push since.
  if (lastRenew && now - lastRenewMs > RENEW_GRACE_MS && lastPushMs < lastRenewMs) {
    return { kind: "danger", code: "watch-armed-no-push", renewedAt: lastRenew.received_at };
  }

  // RED: 24h of zero push but watch active.
  if (stats && stats.push24 === 0 && stats.poll24 > 0 && watchActive) {
    return {
      kind: "danger",
      code: "no-push-24h",
      poll24: stats.poll24,
      synced24: stats.synced24,
    };
  }

  // AMBER: poll has stalled.
  const lastPollMs = stats?.lastPollAt ? new Date(stats.lastPollAt).getTime() : 0;
  const pollSilentMin = stats?.lastPollAt ? Math.floor((now - lastPollMs) / 60000) : null;
  const pollStalled =
    (pollSilentMin === null || pollSilentMin >= POLL_STALE_MIN) && (stats?.push24 ?? 0) > 0;
  if (pollStalled) {
    return { kind: "warn", code: "poll-stalled", pollSilentMin };
  }

  // AMBER: total silence.
  if (stats && stats.push24 === 0 && stats.poll24 === 0) {
    return { kind: "warn", code: "total-silence" };
  }

  // GREEN: push healthy.
  const pushSilentMin = stats?.lastPushAt
    ? Math.floor((now - new Date(stats.lastPushAt).getTime()) / 60000)
    : null;
  const pushHealthy =
    stats &&
    stats.push24 > 0 &&
    stats.push24 - (stats.pushUnmatched24 ?? 0) > 0 &&
    pushSilentMin !== null &&
    pushSilentMin < PUSH_STALE_MIN;
  if (pushHealthy) {
    return {
      kind: "success",
      code: "push-healthy",
      push24: stats.push24,
      lastPushAt: stats.lastPushAt ?? "",
    };
  }

  // INFO: poll keeping it alive.
  if (stats && !pushHealthy && stats.poll24 > 0) {
    return {
      kind: "info",
      code: "poll-fallback",
      poll24: stats.poll24,
      synced24: stats.synced24,
    };
  }

  return null;
}
