import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type EmailRow = {
  id: string;
  user_id: string;
  gmail_message_id: string;
  received_at: string | null;
  is_archived: boolean | null;
  folder_id: string | null;
  gmail_account_id?: string | null;
  raw_labels?: string[] | null;
  classified_by?: string | null;
  surfaced_to_inbox?: boolean | null;
  folder?: {
    auto_archive?: boolean | null;
    hide_from_inbox?: boolean | null;
  } | null;
  [key: string]: unknown;
};

// Mail still being classified/filed by the backend.
//   'pending'    — the row is still being repaired/populated (missing
//                  body/headers); never surface it in any settled view.
//   'pending_ai' — the row is fully parsed and only waiting on the AI
//                  step. It IS surfaced in the Inbox ('all') so new mail
//                  appears instantly, then settles into its folder once
//                  AI finishes. It stays hidden from No-rules / folder
//                  views (those only show settled mail). Kept in sync
//                  with the server RPC get_emails_list_decrypted.
// The "All mail" diagnostic scope shows everything regardless.
function isFullyPending(row: EmailRow): boolean {
  return row.classified_by === "pending";
}

function isPendingAi(row: EmailRow): boolean {
  return row.classified_by === "pending_ai";
}

/**
 * Heuristic: do we believe `row` belongs in the list identified by
 * `queryKey`? Inbox queries use the shape:
 *
 *   ["emails", accountId, scope, paginationOrSearchKey]
 *
 * where `scope` is one of: "all" (INBOX label), "all_mail" (no filter),
 * "no_rules" (folder_id null + no user Label_*), a folder UUID, or
 * undefined/null. Top-level invalidations may pass just ["emails"].
 *
 * Exported for unit tests. Keep in sync with the inbox.tsx query keys.
 */
export function rowBelongsInList(row: EmailRow, queryKey: readonly unknown[]): boolean {
  if (queryKey.length <= 1) return true;

  // [1] = accountId (or legacy scope tag). If it's a string and the row
  // exposes gmail_account_id, require an exact match — otherwise the row
  // belongs to a different account's list. If the row payload doesn't
  // carry gmail_account_id (defensive), fall through and let scope decide.
  const accountTag = queryKey[1];
  if (typeof accountTag === "string" && row.gmail_account_id != null) {
    if (row.gmail_account_id !== accountTag) {
      // Legacy fallback: support older query keys where [1] WAS the scope
      // (e.g. ["emails", "all"]). Only honor recognised scope strings.
      if (
        accountTag === "all" ||
        accountTag === "all_mail" ||
        accountTag === "inbox" ||
        accountTag === "archived" ||
        accountTag === "no_rules"
      ) {
        return matchesScope(row, accountTag);
      }
      return false;
    }
  } else if (typeof accountTag !== "string" && accountTag != null) {
    // Non-string, non-null tag (numbers, objects) — refuse to guess.
    return false;
  }

  // [2] = scope.
  if (queryKey.length <= 2) return true;
  const scope = queryKey[2];
  if (scope == null) return true;
  if (typeof scope !== "string") return false;

  // Search results are recomputed by the query itself; don't try to splice
  // realtime inserts/updates into them.
  if (queryKey.length > 3) {
    const pageKey = queryKey[3];
    if (typeof pageKey === "string" && pageKey.startsWith("search:")) return false;
  }

  return matchesScope(row, scope);
}

/** Coalesced realtime op buffered before a flush. Later ops for the
 * same id win — the buffer self-deduplicates. */
export type PendingRealtimeOp =
  | { kind: "insert"; row: EmailRow }
  | { kind: "update"; row: EmailRow }
  | { kind: "delete"; row: { id: string } };

/** Pure: apply a batch of coalesced ops to one cached list. Returns the
 * next list (sorted) plus whether a refetch is needed for any "row newly
 * belongs but wasn't present" case. Returns null `next` when nothing
 * changed — caller leaves the list untouched (avoids re-renders).
 *
 * Exported so the coalescer logic can be unit-tested without spinning
 * up React or React Query. */
export function applyPendingOpsToList(
  rows: EmailRow[],
  ops: PendingRealtimeOp[],
  queryKey: readonly unknown[],
): { next: EmailRow[] | null; needsRefetch: boolean } {
  let next = rows;
  let mutated = false;
  let needsRefetch = false;
  for (const op of ops) {
    if (op.kind === "insert") {
      if (!rowBelongsInList(op.row, queryKey)) continue;
      if (next.some((r) => r.id === op.row.id)) continue;
      next = [op.row, ...next];
      mutated = true;
    } else if (op.kind === "update") {
      const present = next.some((r) => r.id === op.row.id);
      const belongs = rowBelongsInList(op.row, queryKey);
      if (present && !belongs) {
        next = next.filter((r) => r.id !== op.row.id);
        mutated = true;
      } else if (present && belongs) {
        next = next.map((r) => (r.id === op.row.id ? { ...r, ...op.row } : r));
        mutated = true;
      } else if (!present && belongs) {
        needsRefetch = true;
      }
    } else if (op.kind === "delete") {
      if (!next.some((r) => r.id === op.row.id)) continue;
      next = next.filter((r) => r.id !== op.row.id);
      mutated = true;
    }
  }
  if (!mutated) return { next: null, needsRefetch };
  next = next.slice().sort((a, b) => {
    const ta = a.received_at ? new Date(a.received_at).getTime() : 0;
    const tb = b.received_at ? new Date(b.received_at).getTime() : 0;
    return tb - ta;
  });
  return { next, needsRefetch };
}

function matchesScope(row: EmailRow, scope: string): boolean {
  if (scope === "all_mail") return true;
  // 'pending' rows are still being repaired/populated: never surface them
  // in a settled view.
  if (isFullyPending(row)) return false;
  if (scope === "all" || scope === "inbox") {
    const inInbox =
      row.is_archived !== true && Array.isArray(row.raw_labels) && row.raw_labels.includes("INBOX");
    // AI-pending mail is surfaced in the inbox immediately (gated only on
    // the INBOX label), then settles into its folder once AI finishes.
    if (isPendingAi(row)) return inInbox;
    // A surfaced email is kept in the inbox even though its folder would
    // normally hide/archive it.
    if (row.surfaced_to_inbox === true) return inInbox;
    return inInbox && row.folder?.auto_archive !== true && row.folder?.hide_from_inbox !== true;
  }
  // Beyond the inbox, AI-pending mail is not yet settled: keep it hidden
  // from archived / no-rules / folder views until classification lands.
  if (isPendingAi(row)) return false;
  if (scope === "archived") return row.is_archived === true;
  if (scope === "no_rules") {
    if (row.folder_id !== null) return false;
    const labels = Array.isArray(row.raw_labels) ? row.raw_labels : [];
    return !labels.some((l) => typeof l === "string" && l.startsWith("Label_"));
  }
  // Any other string is treated as a folder UUID.
  return row.folder_id === scope;
}

/** Structural shape of a realtime postgres_changes event as delivered by
 * supabase-js. Kept loose so the damaged-payload guard works across event
 * types and client versions. */
export type RealtimeEventLike = {
  eventType?: string;
  errors?: unknown;
  new?: unknown;
  old?: unknown;
};

/**
 * True when a realtime push arrived unusable — the realtime service flagged
 * an error (oversized rows get stripped or replaced with an error notice) or
 * the row payload is missing its id. Subscribers must treat a damaged push
 * as "something changed, re-fetch" instead of silently ignoring it.
 * Exported for unit tests.
 */
export function isDamagedPayload(payload: RealtimeEventLike): boolean {
  const errs = payload.errors;
  if (Array.isArray(errs) ? errs.length > 0 : Boolean(errs)) return true;
  const record = payload.eventType === "DELETE" ? payload.old : payload.new;
  if (record == null || typeof record !== "object") return true;
  return typeof (record as { id?: unknown }).id !== "string";
}

/**
 * Single source of truth for inbox realtime + catch-up.
 * - Subscribes to postgres_changes on emails/folders, scoped to the current user.
 * - Re-authenticates the realtime socket so RLS lets payloads through.
 * - INSERT events prepend optimistically to the cached email lists so the new
 *   row appears without waiting for a refetch roundtrip.
 * - UPDATE events patch the existing row in place.
 * - DELETE events drop the row from cached lists.
 * - Catches up on tab visibility change (handles dropped websockets after sleep).
 */
export function useEmailRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    // Liveness watchdog: a websocket can silently stop delivering while the
    // channel still reports "joined" (a zombie socket after sleep/network
    // flaps). We track the last time we saw ANY realtime traffic and poll
    // the channel state; if it's no longer joined, we rebuild it proactively
    // instead of waiting for the 30s background sync.
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;
    let lastEventAt = Date.now();
    const REALTIME_WATCHDOG_INTERVAL_MS = 15_000;

    type CachedList = EmailRow[] | { rows: EmailRow[] };
    type FolderRow = {
      id: string;
      auto_archive?: boolean | null;
      hide_from_inbox?: boolean | null;
    };

    function withCachedFolder(row: EmailRow): EmailRow {
      if (!row.folder_id || row.folder) return row;
      const folders = qc.getQueriesData<FolderRow[]>({ queryKey: ["folders"] });
      for (const [key, value] of folders) {
        if (!Array.isArray(value)) continue;
        const queryKey = key as unknown[];
        if (
          typeof row.gmail_account_id === "string" &&
          typeof queryKey[1] === "string" &&
          queryKey[1] !== row.gmail_account_id
        ) {
          continue;
        }
        const folder = value.find((candidate) => candidate.id === row.folder_id);
        if (folder) return { ...row, folder };
      }
      return row;
    }

    function patchOneQuery(
      key: unknown[],
      transform: (rows: EmailRow[]) => EmailRow[] | null,
    ): void {
      qc.setQueryData<CachedList | undefined>(key as readonly unknown[], (old) => {
        if (!old) return old;
        if (Array.isArray(old)) {
          const next = transform(old);
          return next ?? old;
        }
        if (Array.isArray(old.rows)) {
          const next = transform(old.rows);
          return next ? { ...old, rows: next } : old;
        }
        return old;
      });
    }

    // Coalesce realtime events into a single rAF tick. A catch-up burst
    // that delivers N events within ~16ms now collapses to ONE
    // setQueryData call per cached query — one React render instead of N.
    // Buffer is keyed by row id; later events for the same id win
    // (UPDATE after INSERT, DELETE after either) so it self-deduplicates.
    const pending = new Map<string, PendingRealtimeOp>();
    let rafHandle: number | null = null;

    function flush() {
      rafHandle = null;
      if (pending.size === 0) return;
      const ops = Array.from(pending.values());
      pending.clear();

      const entries = qc.getQueriesData<CachedList>({ queryKey: ["emails"] });
      let anyRefetch = false;
      for (const [key] of entries) {
        patchOneQuery(key as unknown[], (rows) => {
          const { next, needsRefetch } = applyPendingOpsToList(rows, ops, key as unknown[]);
          if (needsRefetch) anyRefetch = true;
          return next;
        });
      }
      if (anyRefetch) {
        Promise.resolve().then(() => qc.invalidateQueries({ queryKey: ["emails"] }));
      }
      bumpCounts();
    }

    function scheduleFlush() {
      if (rafHandle !== null) return;
      if (typeof requestAnimationFrame === "function") {
        rafHandle = requestAnimationFrame(flush);
      } else {
        rafHandle = setTimeout(flush, 16) as unknown as number;
      }
      bumpCounts();
    }

    function applyInsert(row: EmailRow) {
      lastEventAt = Date.now();
      pending.set(row.id, { kind: "insert", row: withCachedFolder(row) });
      scheduleFlush();
    }

    function applyUpdate(row: EmailRow) {
      // An update supersedes a pending insert (the row already exists in
      // the DB; we want the latest version).
      lastEventAt = Date.now();
      pending.set(row.id, { kind: "update", row: withCachedFolder(row) });
      scheduleFlush();
    }

    function applyDelete(row: { id: string }) {
      lastEventAt = Date.now();
      pending.set(row.id, { kind: "delete", row });
      scheduleFlush();
    }

    const invalidateFolders = () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
      qc.invalidateQueries({ queryKey: ["emails"] });
      bumpCounts();
    };

    // Unread/folder counts now live under their own key (a cheap server-side
    // aggregate), so they're not swept by ["emails"] mutations. Refresh them
    // explicitly whenever an email row changes read/label/folder state.
    const bumpCounts = () => qc.invalidateQueries({ queryKey: ["folder-counts"] });

    // A damaged push tells us SOMETHING changed without saying what (the
    // realtime service strips oversized rows; RLS can withhold fields).
    // Re-fetch the lists instead of ignoring it — throttled so an error
    // burst costs one round-trip, not one per event.
    let lastDamagedRefetchAt = 0;
    function refetchFromDamagedPush() {
      const now = Date.now();
      if (now - lastDamagedRefetchAt < 5000) return;
      lastDamagedRefetchAt = now;
      qc.invalidateQueries({ queryKey: ["emails"] });
      bumpCounts();
    }

    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      const delays = [1000, 2000, 5000];
      const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
      reconnectAttempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        teardown();
        connect();
      }, delay);
    }

    // Watchdog: while the tab is visible, verify the channel is still
    // actually joined. A zombie socket (joined but not delivering) or one
    // that dropped without firing our status callback gets torn down and
    // rebuilt here, tightening the worst case from the 30s background sync
    // to ~15s. Skipped while hidden (realtime is expected idle) and while a
    // reconnect is already scheduled.
    function checkRealtimeLiveness() {
      if (cancelled || reconnectTimer) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const state = channel?.state;
      const channelDead = !channel || (state !== "joined" && state !== "joining");
      // The underlying phoenix socket can drop without our channel status
      // callback firing (a zombie). If it reports disconnected while we've
      // seen no realtime traffic recently, treat the channel as stale too.
      let socketDead = false;
      try {
        const idleMs = Date.now() - lastEventAt;
        socketDead = idleMs > REALTIME_WATCHDOG_INTERVAL_MS && !supabase.realtime.isConnected();
      } catch {
        // isConnected may not exist on older clients; ignore.
      }
      if (channelDead || socketDead) {
        teardown();
        connect();
      }
    }

    function startWatchdog() {
      if (watchdogTimer) return;
      watchdogTimer = setInterval(checkRealtimeLiveness, REALTIME_WATCHDOG_INTERVAL_MS);
    }



    async function connect() {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session || cancelled) return;

      try {
        supabase.realtime.setAuth(session.access_token);
      } catch {
        // older clients may not need this; ignore.
      }

      const userFilter = `user_id=eq.${session.user.id}`;
      const channelId = `inbox-rt-${session.user.id}-${Math.random().toString(36).slice(2, 10)}`;
      channel = supabase
        .channel(channelId)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "emails", filter: userFilter },
          (payload) => {
            if (isDamagedPayload(payload)) {
              refetchFromDamagedPush();
              return;
            }
            applyInsert(payload.new as EmailRow);
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "emails", filter: userFilter },
          (payload) => {
            if (isDamagedPayload(payload)) {
              refetchFromDamagedPush();
              return;
            }
            applyUpdate(payload.new as EmailRow);
          },
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "emails", filter: userFilter },
          (payload) => {
            if (isDamagedPayload(payload)) {
              refetchFromDamagedPush();
              return;
            }
            applyDelete(payload.old as { id: string });
          },
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "folders", filter: userFilter },
          invalidateFolders,
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            reconnectAttempt = 0;
            lastEventAt = Date.now();
            startWatchdog();
            // Catch up on anything missed while disconnected.
            qc.invalidateQueries({ queryKey: ["emails"] });
            qc.invalidateQueries({ queryKey: ["folders"] });
            bumpCounts();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            scheduleReconnect();
          }
        });
    }

    function teardown() {
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
      if (rafHandle !== null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafHandle);
        else clearTimeout(rafHandle as unknown as ReturnType<typeof setTimeout>);
        rafHandle = null;
      }
      pending.clear();
    }

    connect();

    // Reconnect / re-auth realtime on session changes. TOKEN_REFRESHED fires
    // every ~hour; without re-applying the new JWT, RLS-filtered postgres_changes
    // events silently stop flowing.
    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && session) {
        try {
          supabase.realtime.setAuth(session.access_token);
        } catch {
          // ignore
        }
        return;
      }
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
      teardown();
      connect();
    });

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // Rebuild the channel first if it went stale while hidden, then
        // catch up on anything realtime missed during the gap.
        checkRealtimeLiveness();
        qc.invalidateQueries({ queryKey: ["emails"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        bumpCounts();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      teardown();
      authSub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc]);
}
