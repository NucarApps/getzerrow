import { describe, expect, it } from "vitest";
import {
  derivePubsubHealth,
  type PubsubHealth,
  type PubsubHealthInput,
  type PubsubHealthPush,
  type PubsubHealthRenew,
  type PubsubHealthStats,
} from "./pubsub-health";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

/** Minutes before `NOW`, as an ISO timestamp. */
function minutesAgo(n: number): string {
  return new Date(NOW - n * 60_000).toISOString();
}

/** Seconds before `NOW`, as an ISO timestamp. */
function secondsAgo(n: number): string {
  return new Date(NOW - n * 1000).toISOString();
}

function stats(over: Partial<PubsubHealthStats> = {}): PubsubHealthStats {
  return { push24: 0, poll24: 0, synced24: 0, ...over };
}

function push(over: Partial<PubsubHealthPush> = {}): PubsubHealthPush {
  return {
    received_at: minutesAgo(1),
    event_type: "push",
    accounts_matched: 1,
    email_address: "a@example.com",
    ...over,
  };
}

function renew(receivedAt: string): PubsubHealthRenew {
  return { received_at: receivedAt };
}

function derive(over: Partial<PubsubHealthInput> = {}): PubsubHealth | null {
  return derivePubsubHealth({
    stats: undefined,
    lastPush: null,
    lastRenew: null,
    watchActive: false,
    now: NOW,
    ...over,
  });
}

describe("derivePubsubHealth — nothing to say", () => {
  it("returns null when there is no stats block at all", () => {
    expect(derive()).toBeNull();
  });

  it("returns null when push is silent, poll never ran and the watch is off", () => {
    // push24 > 0 keeps the total-silence rung away; poll24 === 0 keeps the
    // fallback rung away; the last push is too old to be healthy.
    expect(
      derive({
        stats: stats({ push24: 3, lastPushAt: minutesAgo(30), lastPollAt: minutesAgo(1) }),
      }),
    ).toBeNull();
  });
});

describe("derivePubsubHealth — rung 1: push arrived but matched no account", () => {
  it("fires when the most recent push matched zero accounts", () => {
    expect(derive({ lastPush: push({ accounts_matched: 0 }) })).toStrictEqual({
      kind: "danger",
      code: "push-unmatched",
      emailAddress: "a@example.com",
    });
  });

  it("reports a null address when the envelope carried none", () => {
    expect(derive({ lastPush: push({ accounts_matched: 0, email_address: null }) })).toStrictEqual({
      kind: "danger",
      code: "push-unmatched",
      emailAddress: null,
    });
  });

  it("treats a missing accounts_matched as zero matches", () => {
    expect(derive({ lastPush: push({ accounts_matched: null }) })).toStrictEqual({
      kind: "danger",
      code: "push-unmatched",
      emailAddress: "a@example.com",
    });
  });

  it("does not fire when the push did match an account", () => {
    expect(derive({ lastPush: push({ accounts_matched: 1 }) })).toBeNull();
  });

  it("does not fire for a poll row that happens to be the newest event", () => {
    expect(derive({ lastPush: push({ event_type: "poll", accounts_matched: 0 }) })).toBeNull();
  });

  it.each([
    ["9 minutes old — still fresh", 9, true],
    ["exactly 10 minutes old — stale", 10, false],
    ["11 minutes old — stale", 11, false],
  ])("%s", (_label, ageMin, expectedToFire) => {
    const result = derive({
      lastPush: push({ accounts_matched: 0, received_at: minutesAgo(ageMin) }),
    });
    expect(result?.code === "push-unmatched").toBe(expectedToFire);
  });

  it("is suppressed when the watch was re-armed after the unmatched push", () => {
    // A re-arm invalidates everything before it: the unmatched push predates
    // the new watch, so it is no longer evidence about the current config.
    expect(
      derive({
        lastPush: push({ accounts_matched: 0, received_at: minutesAgo(2) }),
        lastRenew: renew(minutesAgo(1)),
      })?.code,
    ).not.toBe("push-unmatched");
  });

  it("still fires when the re-arm happened before the unmatched push", () => {
    expect(
      derive({
        lastPush: push({ accounts_matched: 0, received_at: minutesAgo(1) }),
        lastRenew: renew(minutesAgo(2)),
      })?.code,
    ).toBe("push-unmatched");
  });
});

describe("derivePubsubHealth — rung 2: watch armed, no real push since", () => {
  it("fires when the watch was re-armed and no push has arrived after it", () => {
    const renewedAt = minutesAgo(5);
    expect(derive({ lastRenew: renew(renewedAt), lastPush: null })).toStrictEqual({
      kind: "danger",
      code: "watch-armed-no-push",
      renewedAt,
    });
  });

  it.each([
    ["60s after the re-arm — still inside the grace period", 60, false],
    ["61s after the re-arm — grace expired", 61, true],
  ])("%s", (_label, ageSec, expectedToFire) => {
    const result = derive({ lastRenew: renew(secondsAgo(ageSec)) });
    expect(result?.code === "watch-armed-no-push").toBe(expectedToFire);
  });

  it("does not fire once a push arrives after the re-arm", () => {
    expect(
      derive({
        lastRenew: renew(minutesAgo(5)),
        lastPush: push({ received_at: minutesAgo(4), accounts_matched: 2 }),
      }),
    ).toBeNull();
  });

  it("yields to the unmatched-push rung when both conditions hold", () => {
    // A fresh unmatched push after the re-arm satisfies rung 1; rung 2 is
    // then unreachable because lastPushMs > lastRenewMs anyway.
    expect(
      derive({
        lastRenew: renew(minutesAgo(5)),
        lastPush: push({ received_at: minutesAgo(1), accounts_matched: 0 }),
      })?.code,
    ).toBe("push-unmatched");
  });
});

describe("derivePubsubHealth — rung 3: zero pushes in 24h while the watch is active", () => {
  it("fires when polling is carrying the load and the watch is armed", () => {
    expect(
      derive({
        stats: stats({ push24: 0, poll24: 42, synced24: 7, lastPollAt: minutesAgo(1) }),
        watchActive: true,
      }),
    ).toStrictEqual({ kind: "danger", code: "no-push-24h", poll24: 42, synced24: 7 });
  });

  it("does not fire when the watch is inactive — silence is then expected", () => {
    expect(
      derive({
        stats: stats({ push24: 0, poll24: 42, synced24: 7, lastPollAt: minutesAgo(1) }),
        watchActive: false,
      }),
    ).toStrictEqual({ kind: "info", code: "poll-fallback", poll24: 42, synced24: 7 });
  });

  it("does not fire when at least one push landed in the window", () => {
    expect(
      derive({
        stats: stats({ push24: 1, poll24: 42, synced24: 7, lastPollAt: minutesAgo(1) }),
        watchActive: true,
      })?.code,
    ).not.toBe("no-push-24h");
  });

  it("yields to the watch-armed rung when a stale re-arm is also on record", () => {
    expect(
      derive({
        stats: stats({ push24: 0, poll24: 42, synced24: 7 }),
        watchActive: true,
        lastRenew: renew(minutesAgo(5)),
      })?.code,
    ).toBe("watch-armed-no-push");
  });
});

describe("derivePubsubHealth — rung 4: the fallback poll has stalled", () => {
  it.each([
    ["9 minutes of poll silence — fine", 9, false],
    ["exactly 10 minutes — stalled", 10, true],
    ["30 minutes — stalled", 30, true],
  ])("%s", (_label, ageMin, expectedToFire) => {
    const result = derive({
      stats: stats({ push24: 5, lastPushAt: minutesAgo(1), lastPollAt: minutesAgo(ageMin) }),
    });
    expect(result?.code === "poll-stalled").toBe(expectedToFire);
  });

  it("reports the silence in whole minutes so the banner can name it", () => {
    expect(
      derive({
        stats: stats({ push24: 5, lastPushAt: minutesAgo(1), lastPollAt: minutesAgo(37) }),
      }),
    ).toStrictEqual({ kind: "warn", code: "poll-stalled", pollSilentMin: 37 });
  });

  it("reports a null age when no poll is on record at all", () => {
    // The component renders this as "24h+" — the stats window is 24h, so a
    // missing lastPollAt means nothing polled in the whole window.
    expect(derive({ stats: stats({ push24: 5, lastPushAt: minutesAgo(1) }) })).toStrictEqual({
      kind: "warn",
      code: "poll-stalled",
      pollSilentMin: null,
    });
  });

  it("does not fire when push is dead too — that is total silence, not a stalled poll", () => {
    expect(derive({ stats: stats({ push24: 0, poll24: 0 }) })?.code).toBe("total-silence");
  });

  it("takes precedence over the healthy-push rung", () => {
    // Push is live, but the safety net is down and that is what the operator
    // needs to hear.
    expect(
      derive({
        stats: stats({ push24: 12, lastPushAt: minutesAgo(1), lastPollAt: minutesAgo(20) }),
      })?.code,
    ).toBe("poll-stalled");
  });
});

describe("derivePubsubHealth — rung 5: no activity of any kind", () => {
  it("fires when neither push nor poll ran in the window", () => {
    expect(derive({ stats: stats({ push24: 0, poll24: 0 }) })).toStrictEqual({
      kind: "warn",
      code: "total-silence",
    });
  });

  it("yields to the zero-push rung when the watch is active and polling ran", () => {
    expect(derive({ stats: stats({ push24: 0, poll24: 1 }), watchActive: true })?.code).toBe(
      "no-push-24h",
    );
  });
});

describe("derivePubsubHealth — rung 6: push is healthy", () => {
  it("fires when pushes are landing and the newest is recent", () => {
    const lastPushAt = minutesAgo(2);
    expect(
      derive({ stats: stats({ push24: 9, poll24: 3, lastPushAt, lastPollAt: minutesAgo(1) }) }),
    ).toStrictEqual({ kind: "success", code: "push-healthy", push24: 9, lastPushAt });
  });

  it.each([
    ["9 minutes since the last push — healthy", 9, true],
    ["exactly 10 minutes — no longer healthy", 10, false],
  ])("%s", (_label, ageMin, expectedToFire) => {
    const result = derive({
      stats: stats({
        push24: 9,
        poll24: 3,
        lastPushAt: minutesAgo(ageMin),
        lastPollAt: minutesAgo(1),
      }),
    });
    expect(result?.code === "push-healthy").toBe(expectedToFire);
  });

  it("is not healthy when every push in the window went unmatched", () => {
    expect(
      derive({
        stats: stats({
          push24: 4,
          pushUnmatched24: 4,
          poll24: 3,
          synced24: 1,
          lastPushAt: minutesAgo(1),
          lastPollAt: minutesAgo(1),
        }),
      }),
    ).toStrictEqual({ kind: "info", code: "poll-fallback", poll24: 3, synced24: 1 });
  });

  it("is healthy when only some pushes went unmatched", () => {
    expect(
      derive({
        stats: stats({
          push24: 4,
          pushUnmatched24: 3,
          poll24: 3,
          lastPushAt: minutesAgo(1),
          lastPollAt: minutesAgo(1),
        }),
      })?.code,
    ).toBe("push-healthy");
  });

  it("is not healthy when the counter is up but no push timestamp was recorded", () => {
    expect(
      derive({ stats: stats({ push24: 4, poll24: 3, synced24: 2, lastPollAt: minutesAgo(1) }) }),
    ).toStrictEqual({ kind: "info", code: "poll-fallback", poll24: 3, synced24: 2 });
  });
});

describe("derivePubsubHealth — rung 7: poll is keeping mail flowing", () => {
  it("fires when push is degraded but polling still runs", () => {
    expect(
      derive({
        stats: stats({
          push24: 2,
          pushUnmatched24: 2,
          poll24: 30,
          synced24: 11,
          lastPushAt: minutesAgo(1),
          lastPollAt: minutesAgo(1),
        }),
      }),
    ).toStrictEqual({ kind: "info", code: "poll-fallback", poll24: 30, synced24: 11 });
  });

  it("does not fire when polling is not running either", () => {
    expect(
      derive({
        stats: stats({
          push24: 2,
          pushUnmatched24: 2,
          poll24: 0,
          lastPushAt: minutesAgo(1),
          lastPollAt: minutesAgo(1),
        }),
      }),
    ).toBeNull();
  });
});

describe("derivePubsubHealth — the ladder is ordered", () => {
  it("picks the most severe rung when every condition holds at once", () => {
    // Unmatched fresh push + stale re-arm + zero-push stats + stalled poll:
    // rung 1 wins because an unmatched push is the most actionable signal.
    expect(
      derive({
        stats: stats({ push24: 0, poll24: 5, synced24: 1 }),
        watchActive: true,
        lastPush: push({ accounts_matched: 0, received_at: minutesAgo(1) }),
        lastRenew: renew(minutesAgo(30)),
      })?.kind,
    ).toBe("danger");
  });

  it("does not read the wall clock — the same inputs at a later `now` age out", () => {
    const lastPushAt = minutesAgo(5);
    const base = { stats: stats({ push24: 3, lastPushAt, lastPollAt: minutesAgo(1) }) };
    expect(derive(base)?.code).toBe("push-healthy");
    expect(derive({ ...base, now: NOW + 10 * 60_000 })?.code).not.toBe("push-healthy");
  });
});
