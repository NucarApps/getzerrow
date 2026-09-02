import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { createCoalescedInvalidator } from "@/lib/coalesced-invalidate";
import { createRafCoalescer, createRealtimeConnection } from "@/lib/ui/realtime-coalescer";

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
  snoozed_until?: string | null;
  folder?: {
    auto_archive?: boolean | null;
    hide_from_inbox?: boolean | null;
  } | null;
  /** Client-only tag: AI classification just filed this row out of the
   * current view. It dwells briefly (rendered subdued as "Filed") until the
   * next sweep op removes it, instead of vanishing mid-glance. Never comes
   * from the server; any refetch naturally clears it. */
  _settledOut?: boolean;
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
 * same id win — the buffer self-deduplicates. "sweep" removes any rows
 * left dwelling with `_settledOut` (see below). */
export type PendingRealtimeOp =
  | { kind: "insert"; row: EmailRow }
  | { kind: "update"; row: EmailRow }
  | { kind: "delete"; row: { id: string } }
  | { kind: "sweep" };

/** Pure: apply a batch of coalesced ops to one cached list. Returns the
 * next list (sorted) plus whether a refetch is needed for any "row newly
 * belongs but wasn't present" case, and whether any pending_ai row was
 * tagged settled-out (caller schedules a delayed sweep). Returns null
 * `next` when nothing changed — caller leaves the list untouched (avoids
 * re-renders).
 *
 * Exported so the coalescer logic can be unit-tested without spinning
 * up React or React Query. */
export function applyPendingOpsToList(
  rows: EmailRow[],
  ops: PendingRealtimeOp[],
  queryKey: readonly unknown[],
): { next: EmailRow[] | null; needsRefetch: boolean; hasSettledOut: boolean } {
  let next = rows;
  let mutated = false;
  let needsRefetch = false;
  let hasSettledOut = false;
  for (const op of ops) {
    if (op.kind === "sweep") {
      if (next.some((r) => r._settledOut === true)) {
        next = next.filter((r) => r._settledOut !== true);
        mutated = true;
      }
    } else if (op.kind === "insert") {
      if (!rowBelongsInList(op.row, queryKey)) continue;
      if (next.some((r) => r.id === op.row.id)) continue;
      next = [op.row, ...next];
      mutated = true;
    } else if (op.kind === "update") {
      const cached = next.find((r) => r.id === op.row.id);
      const belongs = rowBelongsInList(op.row, queryKey);
      if (cached && !belongs) {
        // AI classification just filed a freshly-arrived row out of this
        // view: let it dwell tagged so the list doesn't yank it mid-glance.
        // Anything else leaving the view (user archive/move, still-pending
        // rows) is removed instantly — that's direct feedback to an action.
        if (isPendingAi(cached) && !isPendingAi(op.row)) {
          next = next.map((r) => (r.id === op.row.id ? { ...r, ...op.row, _settledOut: true } : r));
          hasSettledOut = true;
        } else {
          next = next.filter((r) => r.id !== op.row.id);
        }
        mutated = true;
      } else if (cached && belongs) {
        next = next.map((r) => (r.id === op.row.id ? { ...r, ...op.row } : r));
        mutated = true;
      } else if (!cached && belongs) {
        needsRefetch = true;
      }
    } else if (op.kind === "delete") {
      if (!next.some((r) => r.id === op.row.id)) continue;
      next = next.filter((r) => r.id !== op.row.id);
      mutated = true;
    }
  }
  if (!mutated) return { next: null, needsRefetch, hasSettledOut };
  next = next.slice().sort((a, b) => {
    const ta = a.received_at ? new Date(a.received_at).getTime() : 0;
    const tb = b.received_at ? new Date(b.received_at).getTime() : 0;
    return tb - ta;
  });
  return { next, needsRefetch, hasSettledOut };
}

function matchesScope(row: EmailRow, scope: string): boolean {
  if (scope === "all_mail") return true;
  // 'pending' rows are still being repaired/populated: never surface them
  // in a settled view.
  if (isFullyPending(row)) return false;
  // Snoozed mail is excluded from every settled view server-side (the
  // get_emails_list_decrypted RPC filters snoozed_until > now() for all
  // scopes except all_mail) — a realtime event must not splice it back in.
  if (typeof row.snoozed_until === "string") {
    const until = new Date(row.snoozed_until).getTime();
    if (Number.isFinite(until) && until > Date.now()) return false;
  }
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
    // Liveness watchdog: a websocket can silently stop delivering while the
    // channel still reports "joined" (a zombie socket after sleep/network
    // flaps). The shared connection tracks the last time we saw ANY realtime
    // traffic and polls the channel state; if it's no longer joined, it
    // rebuilds proactively instead of waiting for the 30s background sync.
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

    // Dwell timer for settled-out rows (AI just filed them out of view).
    // One shared sweep per batch; a refetch replacing the list wholesale
    // also clears tags, so a missed sweep can never strand a row.
    let settleSweepTimer: ReturnType<typeof setTimeout> | null = null;
    const SETTLED_OUT_DWELL_MS = 4_000;
    const SWEEP_OP_KEY = " sweep";

    function scheduleSettleSweep() {
      if (settleSweepTimer !== null) return;
      settleSweepTimer = setTimeout(() => {
        settleSweepTimer = null;
        coalescer.push(SWEEP_OP_KEY, { kind: "sweep" });
      }, SETTLED_OUT_DWELL_MS);
    }

    // Coalesce realtime events into a single rAF tick. A catch-up burst that
    // delivers N events within ~16ms collapses to ONE setQueryData call per
    // cached query — one React render instead of N — and ONE folder-count
    // invalidation. The buffer is keyed by row id, so later events for the
    // same id win (UPDATE after INSERT, DELETE after either).
    const coalescer = createRafCoalescer<PendingRealtimeOp>({
      flush(ops) {
        const entries = qc.getQueriesData<CachedList>({ queryKey: ["emails"] });
        let anyRefetch = false;
        let anySettledOut = false;
        for (const [key] of entries) {
          patchOneQuery(key as unknown[], (rows) => {
            const { next, needsRefetch, hasSettledOut } = applyPendingOpsToList(
              rows,
              ops,
              key as unknown[],
            );
            if (needsRefetch) anyRefetch = true;
            if (hasSettledOut) anySettledOut = true;
            return next;
          });
        }
        if (anySettledOut) scheduleSettleSweep();
        if (anyRefetch) {
          Promise.resolve().then(() => qc.invalidateQueries({ queryKey: ["emails"] }));
        }
        // Counts are bumped once per batch here — never once per event.
        bumpCounts();
      },
    });

    function applyInsert(row: EmailRow) {
      connection.markActivity();
      coalescer.push(row.id, { kind: "insert", row: withCachedFolder(row) });
    }

    function applyUpdate(row: EmailRow) {
      // An update supersedes a pending insert (the row already exists in
      // the DB; we want the latest version).
      connection.markActivity();
      coalescer.push(row.id, { kind: "update", row: withCachedFolder(row) });
    }

    function applyDelete(row: { id: string }) {
      connection.markActivity();
      coalescer.push(row.id, { kind: "delete", row });
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
    // Re-fetch the lists instead of ignoring it — coalesced so an error
    // burst costs one round-trip, not one per event.
    const damagedPushInvalidator = createCoalescedInvalidator((keys) => {
      for (const key of keys) qc.invalidateQueries({ queryKey: key as unknown[] });
    });
    function refetchFromDamagedPush() {
      damagedPushInvalidator.request(["emails"]);
      damagedPushInvalidator.request(["folder-counts"]);
    }

    const connection = createRealtimeConnection<ReturnType<typeof supabase.channel>>({
      channelPrefix: "inbox-rt",
      watchdogIntervalMs: REALTIME_WATCHDOG_INTERVAL_MS,
      async session() {
        const { data } = await supabase.auth.getSession();
        const s = data.session;
        return s ? { accessToken: s.access_token, userId: s.user.id } : null;
      },
      setAuth: (token) => supabase.realtime.setAuth(token),
      socketConnected: () => supabase.realtime.isConnected(),
      onAuthEvent(handler) {
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
          handler(event, session?.access_token ?? null);
        });
        return () => data.subscription.unsubscribe();
      },
      stateOf: (channel) => channel.state,
      close: (channel) => void supabase.removeChannel(channel),
      open: ({ channelId, userFilter, onStatus }) =>
        supabase
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
          .subscribe(onStatus),
      onSubscribed() {
        // Catch up on anything missed while disconnected.
        qc.invalidateQueries({ queryKey: ["emails"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        bumpCounts();
      },
      onTeardown: () => coalescer.clear(),
      // Rebuild the channel if it went stale while hidden. When it was
      // healthy the whole time, realtime already patched the cache — no
      // blanket invalidate. (A rebuild's SUBSCRIBED handler catches up; the
      // emails query's own staleTime-gated focus refetch covers the rest.)
      // The old unconditional triple-invalidate here was the main source of
      // the focus-time decrypt burst.
      onVisible: ({ checkLiveness }) => void checkLiveness(),
    });

    connection.start();

    return () => {
      if (settleSweepTimer) {
        clearTimeout(settleSweepTimer);
        settleSweepTimer = null;
      }
      damagedPushInvalidator.dispose();
      connection.stop();
    };
  }, [qc]);
}
