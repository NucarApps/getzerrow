// The connection and event-batching machinery behind the realtime hooks.
//
// `useEmailRealtime` and `useContactsRealtime` had two near-identical copies
// of the same 80 lines: re-auth the socket, reconnect on a backoff ladder,
// rebuild a zombie channel while the tab is visible, tear everything down on
// unmount. Copy two of a reconnect ladder is where the drift starts, and
// none of it was reachable from a test while it lived inside a useEffect.
//
// Both pieces here are plain factories with injected dependencies: no React,
// no supabase import, no globals beyond an optional `document`. The hooks
// keep only the part that is actually theirs — which query keys to patch.

/** Phoenix channel states that still count as a live channel. */
const ALIVE_STATES = new Set(["joined", "joining"]);

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000] as const;

/* -------------------------------------------------------------------------- */
/* Frame coalescer                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Buffers keyed ops and flushes them once per animation frame.
 *
 * A catch-up burst delivers N realtime events within a millisecond or two;
 * without this every one of them costs a cache write and a React render.
 * Later ops for the same key overwrite earlier ones, so the buffer also
 * self-deduplicates (an UPDATE supersedes a pending INSERT for the same row).
 */
export type RafCoalescer<T> = {
  /** Buffer an op under `key` and make sure a flush is scheduled. */
  push: (key: string, op: T) => void;
  /** Schedule a flush without adding anything (nothing happens if empty). */
  schedule: () => void;
  /** Drop the buffer and any scheduled flush. */
  clear: () => void;
  /** Buffered op count — for assertions and empty checks. */
  size: () => number;
};

export type RafCoalescerOptions<T> = {
  /** Receives the buffered ops in insertion order. Never called empty. */
  flush: (ops: T[]) => void;
  /** Defaults to requestAnimationFrame, or a 16ms timer where it is absent. */
  scheduleFrame?: (run: () => void) => number;
  cancelFrame?: (handle: number) => void;
};

export function createRafCoalescer<T>(options: RafCoalescerOptions<T>): RafCoalescer<T> {
  const scheduleFrame =
    options.scheduleFrame ??
    ((run: () => void) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : (setTimeout(run, 16) as unknown as number));
  const cancelFrame =
    options.cancelFrame ??
    ((handle: number) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
      else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    });

  const pending = new Map<string, T>();
  let handle: number | null = null;

  function run() {
    handle = null;
    if (pending.size === 0) return;
    const ops = Array.from(pending.values());
    pending.clear();
    options.flush(ops);
  }

  function schedule() {
    if (handle !== null) return;
    handle = scheduleFrame(run);
  }

  return {
    push(key, op) {
      pending.set(key, op);
      schedule();
    },
    schedule,
    clear() {
      if (handle !== null) {
        cancelFrame(handle);
        handle = null;
      }
      pending.clear();
    },
    size: () => pending.size,
  };
}

/* -------------------------------------------------------------------------- */
/* Connection lifecycle                                                        */
/* -------------------------------------------------------------------------- */

/** The slice of `document` this module touches. */
export type VisibilityDocument = {
  visibilityState: string;
  addEventListener: (type: "visibilitychange", listener: () => void) => void;
  removeEventListener: (type: "visibilitychange", listener: () => void) => void;
};

export type RealtimeSession = { accessToken: string; userId: string };

export type RealtimeConnectionOptions<Ch> = {
  /** Prefix of the generated channel id, e.g. "inbox-rt". */
  channelPrefix: string;
  /** Current session, or null when signed out (then nothing is opened). */
  session: () => Promise<RealtimeSession | null>;
  /** Re-apply the JWT to the realtime socket. Throwing is tolerated: older
   * clients do not need it and must not break the connection. */
  setAuth: (accessToken: string) => void;
  /** Build AND subscribe the channel, wiring `onStatus` to `.subscribe()`. */
  open: (args: {
    channelId: string;
    userFilter: string;
    userId: string;
    onStatus: (status: string) => void;
  }) => Ch;
  close: (channel: Ch) => void;
  /** The channel's phoenix state ("joined", "closed", …). */
  stateOf: (channel: Ch) => string | undefined;
  /** Subscribe to auth events; returns the unsubscribe. */
  onAuthEvent: (handler: (event: string, accessToken: string | null) => void) => () => void;
  /** Whether the underlying socket believes it is connected. Optional: a
   * client without it just skips the zombie-socket half of the check. */
  socketConnected?: () => boolean;
  /** Ran on every successful SUBSCRIBED — the catch-up. */
  onSubscribed: () => void;
  /** Ran on every teardown (reconnect, sign-out, unmount). */
  onTeardown?: () => void;
  /** Ran when the tab becomes visible. Default: a liveness check. */
  onVisible?: (api: { checkLiveness: () => boolean }) => void;
  /** Backoff ladder; the last delay repeats. */
  reconnectDelaysMs?: readonly number[];
  /** Poll the channel this often while visible. Omit to disable. */
  watchdogIntervalMs?: number;
  /** Defaults to the global `document` when there is one. */
  doc?: VisibilityDocument | null;
};

export type RealtimeConnection = {
  start: () => void;
  /** Cancel every timer, remove the channel, unsubscribe from auth. */
  stop: () => void;
  /** Record that realtime traffic just arrived, so the watchdog does not
   * mistake a busy channel for a dead socket. */
  markActivity: () => void;
  /** Rebuild the channel if it is no longer live. Returns true when it did —
   * the new channel's SUBSCRIBED handler runs the catch-up, so a caller must
   * not also invalidate. */
  checkLiveness: () => boolean;
};

export function createRealtimeConnection<Ch>(
  options: RealtimeConnectionOptions<Ch>,
): RealtimeConnection {
  const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const doc =
    options.doc !== undefined
      ? options.doc
      : typeof document !== "undefined"
        ? (document as unknown as VisibilityDocument)
        : null;

  let channel: Ch | null = null;
  let cancelled = false;
  let started = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastEventAt = Date.now();
  let unsubscribeAuth: (() => void) | null = null;

  function teardown() {
    options.onTeardown?.();
    if (channel) {
      options.close(channel);
      channel = null;
    }
  }

  function scheduleReconnect() {
    if (cancelled || reconnectTimer) return;
    // The ladder's last rung repeats rather than growing without bound.
    const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      teardown();
      void connect();
    }, delay);
  }

  function startWatchdog() {
    if (watchdogTimer || !options.watchdogIntervalMs) return;
    watchdogTimer = setInterval(checkLiveness, options.watchdogIntervalMs);
  }

  /**
   * A websocket can stop delivering while the channel still reports
   * "joined" (a zombie after sleep or a network flap). Poll for it while the
   * tab is visible — hidden tabs are expected to be idle, and a reconnect
   * that is already scheduled will rebuild the channel anyway.
   */
  function checkLiveness(): boolean {
    if (cancelled || reconnectTimer) return false;
    if (doc && doc.visibilityState !== "visible") return false;
    const state = channel ? options.stateOf(channel) : undefined;
    const channelDead = !channel || !ALIVE_STATES.has(state ?? "");
    let socketDead = false;
    try {
      const idleMs = Date.now() - lastEventAt;
      const interval = options.watchdogIntervalMs ?? 0;
      socketDead = interval > 0 && idleMs > interval && options.socketConnected?.() === false;
    } catch {
      // isConnected may not exist on older clients; ignore.
    }
    if (channelDead || socketDead) {
      teardown();
      void connect();
      return true;
    }
    return false;
  }

  async function connect() {
    const session = await options.session();
    if (!session || cancelled) return;

    try {
      options.setAuth(session.accessToken);
    } catch {
      // older clients may not need this; ignore.
    }

    const suffix = Math.random().toString(36).slice(2, 10);
    channel = options.open({
      channelId: `${options.channelPrefix}-${session.userId}-${suffix}`,
      userFilter: `user_id=eq.${session.userId}`,
      userId: session.userId,
      onStatus: (status) => {
        if (status === "SUBSCRIBED") {
          reconnectAttempt = 0;
          lastEventAt = Date.now();
          startWatchdog();
          options.onSubscribed();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          scheduleReconnect();
        }
      },
    });
  }

  const onVisible = () => {
    if (doc?.visibilityState !== "visible") return;
    if (options.onVisible) options.onVisible({ checkLiveness });
    else checkLiveness();
  };

  return {
    start() {
      if (started) return;
      started = true;
      void connect();
      // TOKEN_REFRESHED fires roughly hourly; without re-applying the new JWT
      // the RLS-filtered postgres_changes stream silently dries up.
      unsubscribeAuth = options.onAuthEvent((event, accessToken) => {
        if (event === "TOKEN_REFRESHED" && accessToken) {
          try {
            options.setAuth(accessToken);
          } catch {
            // ignore
          }
          return;
        }
        if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
        teardown();
        void connect();
      });
      doc?.addEventListener("visibilitychange", onVisible);
    },
    stop() {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      teardown();
      unsubscribeAuth?.();
      unsubscribeAuth = null;
      doc?.removeEventListener("visibilitychange", onVisible);
    },
    markActivity() {
      lastEventAt = Date.now();
    },
    checkLiveness,
  };
}
