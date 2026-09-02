// Tests for the realtime machinery shared by useEmailRealtime and
// useContactsRealtime (src/lib/ui/realtime-coalescer.ts).
//
// This is the code that decides whether a user keeps receiving live mail: a
// reconnect ladder that stalls, a watchdog that rebuilds a healthy channel
// on a loop, or a token refresh that forgets to re-auth the socket all look
// identical from the outside (the list simply stops updating), which is why
// every branch is asserted here rather than through the hooks.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createRafCoalescer,
  createRealtimeConnection,
  type RealtimeConnection,
  type VisibilityDocument,
} from "./realtime-coalescer";

/* -------------------------------------------------------------------------- */
/* createRafCoalescer                                                          */
/* -------------------------------------------------------------------------- */

describe("createRafCoalescer", () => {
  /** A hand-driven frame scheduler: nothing runs until `frame()` is called. */
  function frames() {
    const queued = new Map<number, () => void>();
    let next = 1;
    return {
      scheduleFrame: (run: () => void) => {
        const handle = next++;
        queued.set(handle, run);
        return handle;
      },
      cancelFrame: (handle: number) => void queued.delete(handle),
      pendingFrames: () => queued.size,
      /** Run every scheduled frame callback. */
      frame() {
        const runs = [...queued.values()];
        queued.clear();
        for (const run of runs) run();
      },
    };
  }

  it("collapses many pushes inside one frame into a single flush", () => {
    const f = frames();
    const flush = vi.fn<(ops: string[]) => void>();
    const coalescer = createRafCoalescer<string>({ ...f, flush });

    for (const id of ["a", "b", "c", "d"]) coalescer.push(id, `insert:${id}`);

    expect(flush).not.toHaveBeenCalled();
    expect(f.pendingFrames()).toBe(1);
    f.frame();

    expect(flush.mock.calls).toStrictEqual([[["insert:a", "insert:b", "insert:c", "insert:d"]]]);
  });

  it("keeps only the latest op per key, so an update supersedes a buffered insert", () => {
    const f = frames();
    const flush = vi.fn<(ops: string[]) => void>();
    const coalescer = createRafCoalescer<string>({ ...f, flush });

    coalescer.push("row-1", "insert");
    coalescer.push("row-1", "update");
    coalescer.push("row-1", "delete");
    expect(coalescer.size()).toBe(1);
    f.frame();

    expect(flush.mock.calls).toStrictEqual([[["delete"]]]);
  });

  it("does not call flush when the buffer was cleared before the frame ran", () => {
    const f = frames();
    const flush = vi.fn<(ops: string[]) => void>();
    const coalescer = createRafCoalescer<string>({ ...f, flush });

    coalescer.push("row-1", "insert");
    coalescer.clear();
    f.frame();

    expect(flush).not.toHaveBeenCalled();
    expect(f.pendingFrames()).toBe(0);
    expect(coalescer.size()).toBe(0);
  });

  it("schedules a fresh frame for ops pushed after a flush", () => {
    const f = frames();
    const flush = vi.fn<(ops: string[]) => void>();
    const coalescer = createRafCoalescer<string>({ ...f, flush });

    coalescer.push("row-1", "insert");
    f.frame();
    coalescer.push("row-2", "insert");
    f.frame();

    expect(flush.mock.calls).toStrictEqual([[["insert"]], [["insert"]]]);
  });

  it("falls back to a timer where requestAnimationFrame is absent", async () => {
    vi.useFakeTimers();
    const flush = vi.fn<(ops: string[]) => void>();
    const coalescer = createRafCoalescer<string>({ flush });

    coalescer.push("row-1", "insert");
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);

    expect(flush).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* createRealtimeConnection                                                    */
/* -------------------------------------------------------------------------- */

type FakeChannel = { id: string; state: string; onStatus: (status: string) => void };

type AuthHandler = (event: string, accessToken: string | null) => void;

function makeDoc() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible",
    addEventListener: (_type: "visibilitychange", listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "visibilitychange", listener: () => void) => {
      listeners.delete(listener);
    },
  };
  return {
    doc: doc as VisibilityDocument,
    setVisibility(state: "visible" | "hidden") {
      doc.visibilityState = state;
    },
    fireVisibilityChange() {
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

type HarnessOptions = {
  session?: () => Promise<{ accessToken: string; userId: string } | null>;
  setAuth?: (token: string) => void;
  socketConnected?: () => boolean;
  onVisible?: (api: { checkLiveness: () => boolean }) => void;
  watchdogIntervalMs?: number;
};

function harness(options: HarnessOptions = {}) {
  const opened: FakeChannel[] = [];
  const closed: FakeChannel[] = [];
  const onSubscribed = vi.fn();
  const onTeardown = vi.fn();
  const setAuth = vi.fn<(token: string) => void>(options.setAuth);
  const authHandlers: AuthHandler[] = [];
  const unsubscribeAuth = vi.fn();
  const { doc, ...visibility } = makeDoc();

  const connection: RealtimeConnection = createRealtimeConnection<FakeChannel>({
    channelPrefix: "test-rt",
    doc,
    watchdogIntervalMs: options.watchdogIntervalMs,
    socketConnected: options.socketConnected,
    session: options.session ?? (async () => ({ accessToken: "jwt-1", userId: "user-1" })),
    setAuth,
    onAuthEvent(handler) {
      authHandlers.push(handler);
      return unsubscribeAuth;
    },
    stateOf: (channel) => channel.state,
    close: (channel) => void closed.push(channel),
    open: ({ channelId, onStatus }) => {
      const channel: FakeChannel = { id: channelId, state: "joined", onStatus };
      opened.push(channel);
      return channel;
    },
    onSubscribed,
    onTeardown,
    onVisible: options.onVisible,
  });

  return {
    connection,
    opened,
    closed,
    onSubscribed,
    onTeardown,
    setAuth,
    unsubscribeAuth,
    ...visibility,
    latest: () => opened[opened.length - 1]!,
    emitAuth(event: string, accessToken: string | null) {
      for (const handler of authHandlers) handler(event, accessToken);
    },
    async start() {
      connection.start();
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe("createRealtimeConnection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("opens a user-scoped channel and applies the session JWT to the socket", async () => {
    const h = harness();

    await h.start();

    expect(h.setAuth.mock.calls).toStrictEqual([["jwt-1"]]);
    expect(h.opened).toHaveLength(1);
    expect(h.latest().id).toMatch(/^test-rt-user-1-[a-z0-9]{1,8}$/);
  });

  it("opens nothing when there is no session", async () => {
    const h = harness({ session: async () => null });

    await h.start();

    expect(h.opened).toStrictEqual([]);
    expect(h.setAuth).not.toHaveBeenCalled();
  });

  it("still connects when the client's setAuth throws", async () => {
    const h = harness({
      setAuth: () => {
        throw new Error("no realtime auth on this client");
      },
    });

    await h.start();

    expect(h.opened).toHaveLength(1);
  });

  it("runs the catch-up on every SUBSCRIBED", async () => {
    const h = harness();
    await h.start();

    h.latest().onStatus("SUBSCRIBED");
    h.latest().onStatus("SUBSCRIBED");

    expect(h.onSubscribed).toHaveBeenCalledTimes(2);
  });

  it("climbs the reconnect ladder on CHANNEL_ERROR and repeats its last rung", async () => {
    const h = harness();
    await h.start();

    for (const [attempt, delay] of [1000, 2000, 5000, 5000].entries()) {
      h.latest().onStatus("CHANNEL_ERROR");
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.opened, `must not rebuild before ${delay}ms`).toHaveLength(attempt + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.opened, `must rebuild at ${delay}ms`).toHaveLength(attempt + 2);
    }
    // Every rebuild tore the previous channel down first.
    expect(h.closed).toHaveLength(4);
    expect(h.onTeardown).toHaveBeenCalledTimes(4);
  });

  it("restarts the ladder from its first rung once the channel joins again", async () => {
    const h = harness();
    await h.start();

    h.latest().onStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(1000);
    h.latest().onStatus("SUBSCRIBED");
    h.latest().onStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(999);
    expect(h.opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(h.opened).toHaveLength(3);
  });

  it("collapses a burst of errors into one scheduled reconnect", async () => {
    const h = harness();
    await h.start();

    h.latest().onStatus("CHANNEL_ERROR");
    h.latest().onStatus("TIMED_OUT");
    h.latest().onStatus("CLOSED");
    await vi.advanceTimersByTimeAsync(1000);

    expect(h.opened).toHaveLength(2);
  });

  it("re-auths the socket on TOKEN_REFRESHED without rebuilding the channel", async () => {
    const h = harness();
    await h.start();

    h.emitAuth("TOKEN_REFRESHED", "jwt-2");
    await vi.advanceTimersByTimeAsync(0);

    expect(h.setAuth.mock.calls).toStrictEqual([["jwt-1"], ["jwt-2"]]);
    expect(h.opened).toHaveLength(1);
    expect(h.closed).toStrictEqual([]);
  });

  it("rebuilds the channel on SIGNED_OUT and on SIGNED_IN", async () => {
    const h = harness();
    await h.start();

    h.emitAuth("SIGNED_OUT", null);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened).toHaveLength(2);
    expect(h.closed).toHaveLength(1);

    h.emitAuth("SIGNED_IN", "jwt-3");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened).toHaveLength(3);
  });

  it("ignores auth events that are not a refresh or a sign-in/out", async () => {
    const h = harness();
    await h.start();

    h.emitAuth("USER_UPDATED", "jwt-2");
    h.emitAuth("PASSWORD_RECOVERY", null);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.opened).toHaveLength(1);
    expect(h.setAuth.mock.calls).toStrictEqual([["jwt-1"]]);
  });

  it("ignores a TOKEN_REFRESHED that carries no token", async () => {
    const h = harness();
    await h.start();

    h.emitAuth("TOKEN_REFRESHED", null);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.setAuth.mock.calls).toStrictEqual([["jwt-1"]]);
    expect(h.opened).toHaveLength(1);
  });
});

describe("createRealtimeConnection — liveness watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("rebuilds a channel that is no longer joined while the tab is visible", async () => {
    const h = harness({ watchdogIntervalMs: 15_000 });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");

    h.latest().state = "closed";
    await vi.advanceTimersByTimeAsync(15_000);

    expect(h.opened).toHaveLength(2);
    expect(h.closed).toHaveLength(1);
  });

  it("leaves a dead channel alone while the tab is hidden", async () => {
    const h = harness({ watchdogIntervalMs: 15_000 });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");

    h.latest().state = "closed";
    h.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.opened).toHaveLength(1);
    expect(h.closed).toStrictEqual([]);
  });

  it("treats a joining channel as alive", async () => {
    const h = harness({ watchdogIntervalMs: 15_000 });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");

    h.latest().state = "joining";
    await vi.advanceTimersByTimeAsync(15_000);

    expect(h.opened).toHaveLength(1);
  });

  it("rebuilds a zombie: the channel says joined but the socket is down and nothing has arrived", async () => {
    const h = harness({ watchdogIntervalMs: 15_000, socketConnected: () => false });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.opened).toHaveLength(2);
  });

  it("leaves the channel alone while realtime traffic is still arriving", async () => {
    const h = harness({ watchdogIntervalMs: 15_000, socketConnected: () => false });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");

    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      h.connection.markActivity();
    }

    expect(h.opened).toHaveLength(1);
  });

  it("does not run the watchdog at all when no interval is configured", async () => {
    const h = harness({ socketConnected: () => false });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");

    h.latest().state = "closed";
    await vi.advanceTimersByTimeAsync(300_000);

    expect(h.opened).toHaveLength(1);
  });

  it("checks liveness when the tab becomes visible, and does nothing while it is hidden", async () => {
    const h = harness({ watchdogIntervalMs: 15_000 });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");
    h.latest().state = "closed";

    h.setVisibility("hidden");
    h.fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened).toHaveLength(1);

    h.setVisibility("visible");
    h.fireVisibilityChange();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.opened).toHaveLength(2);
  });

  it("hands the visibility hook to a caller that wants to refresh instead", async () => {
    const onVisible = vi.fn();
    const h = harness({ onVisible });
    await h.start();

    h.fireVisibilityChange();

    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(h.opened).toHaveLength(1);
  });

  it("skips the liveness check while a reconnect is already scheduled", async () => {
    const h = harness({ watchdogIntervalMs: 15_000 });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");
    h.latest().onStatus("CHANNEL_ERROR");

    expect(h.connection.checkLiveness()).toBe(false);
    expect(h.opened).toHaveLength(1);
  });
});

describe("createRealtimeConnection — teardown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("removes the channel, drops the listeners and cancels a pending reconnect", async () => {
    const h = harness({ watchdogIntervalMs: 15_000 });
    await h.start();
    h.latest().onStatus("SUBSCRIBED");
    h.latest().onStatus("CHANNEL_ERROR");

    h.connection.stop();

    expect(h.closed).toHaveLength(1);
    expect(h.onTeardown).toHaveBeenCalledTimes(1);
    expect(h.unsubscribeAuth).toHaveBeenCalledTimes(1);
    expect(h.listenerCount()).toBe(0);

    // Neither the pending reconnect nor the watchdog may resurrect anything.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.opened).toHaveLength(1);
  });

  it("never reconnects after stop, even if a late status arrives", async () => {
    const h = harness();
    await h.start();
    const channel = h.latest();
    h.connection.stop();

    channel.onStatus("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(h.opened).toHaveLength(1);
  });

  it("is idempotent: a second start does not open a second channel", async () => {
    const h = harness();
    await h.start();
    await h.start();

    expect(h.opened).toHaveLength(1);
  });
});
