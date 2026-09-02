// Test-only stand-in for the browser supabase client's realtime surface,
// shared by the hook suites (use-email-realtime, use-contacts-realtime).
//
// The hooks only ever touch `auth.getSession`, `auth.onAuthStateChange`,
// `realtime.setAuth` / `isConnected`, `channel()` and `removeChannel()`, so
// that is all this fake implements. Channels record the postgres_changes
// handlers they were given and the status callback they were subscribed
// with, which is what lets a test deliver an event or a CHANNEL_ERROR by
// hand instead of waiting on a websocket.
//
// Lives in __fixtures__ so it is excluded from the coverage/test globs.
// Consume it inside the module mock factory, which runs before the test
// body — the fake is stashed on a `vi.hoisted` box so both sides see the
// same instance:
//
//   const box = vi.hoisted(() => ({ rt: null as RealtimeClientFake | null }));
//   vi.mock("@/integrations/supabase/client", async () => {
//     const { makeRealtimeClientFake } = await import("@/lib/__fixtures__/realtime-client");
//     box.rt = makeRealtimeClientFake();
//     return { supabase: box.rt.supabase };
//   });

export type ChangeConfig = { event: string; table: string; schema?: string; filter?: string };
export type ChangeHandler = (payload: Record<string, unknown>) => void;

export type FakeRealtimeChannel = {
  id: string;
  /** Phoenix state the liveness watchdog reads; tests may reassign it. */
  state: string;
  handlers: Array<{ config: ChangeConfig; handler: ChangeHandler }>;
  /** The callback passed to `.subscribe()`, for reporting a status. */
  status: ((status: string) => void) | null;
  on: (kind: string, config: ChangeConfig, handler: ChangeHandler) => FakeRealtimeChannel;
  subscribe: (onStatus: (status: string) => void) => FakeRealtimeChannel;
};

export type RealtimeClientFakeOptions = {
  userId?: string;
  accessToken?: string;
  /** Signed out: `getSession` resolves with no session. */
  session?: false;
};

export function makeRealtimeClientFake(options: RealtimeClientFakeOptions = {}) {
  const userId = options.userId ?? "user-1";
  const accessToken = options.accessToken ?? "jwt-1";
  const channels: FakeRealtimeChannel[] = [];
  const removed: FakeRealtimeChannel[] = [];
  const authHandlers: Array<(event: string, session: { access_token: string } | null) => void> = [];
  const setAuthCalls: string[] = [];
  let connected = true;

  const supabase = {
    auth: {
      getSession: async () => ({
        data: {
          session:
            options.session === false ? null : { access_token: accessToken, user: { id: userId } },
        },
      }),
      onAuthStateChange(
        handler: (event: string, session: { access_token: string } | null) => void,
      ) {
        authHandlers.push(handler);
        return {
          data: {
            subscription: {
              unsubscribe: () => {
                const i = authHandlers.indexOf(handler);
                if (i >= 0) authHandlers.splice(i, 1);
              },
            },
          },
        };
      },
    },
    realtime: {
      setAuth: (token: string) => void setAuthCalls.push(token),
      isConnected: () => connected,
    },
    channel(id: string) {
      const channel: FakeRealtimeChannel = {
        id,
        state: "joined",
        handlers: [],
        status: null,
        on(_kind, config, handler) {
          channel.handlers.push({ config, handler });
          return channel;
        },
        subscribe(onStatus) {
          channel.status = onStatus;
          return channel;
        },
      };
      channels.push(channel);
      return channel;
    },
    removeChannel(channel: FakeRealtimeChannel) {
      removed.push(channel);
    },
  };

  return {
    supabase,
    channels,
    removed,
    setAuthCalls,
    /** The most recently opened channel. */
    latest: () => channels[channels.length - 1]!,
    /** Deliver a postgres_changes payload to the handler registered for
     * `table`/`event` on the newest channel. */
    deliver(table: string, event: string, payload: Record<string, unknown>) {
      const entry = channels[channels.length - 1]?.handlers.find(
        (h) => h.config.table === table && h.config.event === event,
      );
      if (!entry) throw new Error(`realtime fake: no handler for ${table}/${event}`);
      entry.handler({ eventType: event, errors: null, ...payload });
    },
    /** Report a subscription status on the newest channel. */
    status(status: string) {
      channels[channels.length - 1]?.status?.(status);
    },
    emitAuth(event: string, token: string | null) {
      for (const handler of [...authHandlers])
        handler(event, token === null ? null : { access_token: token });
    },
    /** Make the underlying socket report itself down (zombie detection). */
    setSocketConnected(next: boolean) {
      connected = next;
    },
    authHandlerCount: () => authHandlers.length,
    reset() {
      channels.length = 0;
      removed.length = 0;
      authHandlers.length = 0;
      setAuthCalls.length = 0;
      connected = true;
    },
  };
}

export type RealtimeClientFake = ReturnType<typeof makeRealtimeClientFake>;
