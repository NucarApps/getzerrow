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
  [key: string]: unknown;
};

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

function matchesScope(row: EmailRow, scope: string): boolean {
  if (scope === "all_mail") return true;
  if (scope === "all" || scope === "inbox") {
    return (
      row.is_archived !== true && Array.isArray(row.raw_labels) && row.raw_labels.includes("INBOX")
    );
  }
  if (scope === "archived") return row.is_archived === true;
  if (scope === "no_rules") {
    if (row.folder_id !== null) return false;
    const labels = Array.isArray(row.raw_labels) ? row.raw_labels : [];
    return !labels.some((l) => typeof l === "string" && l.startsWith("Label_"));
  }
  // Any other string is treated as a folder UUID.
  return row.folder_id === scope;
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

    type CachedList = EmailRow[] | { rows: EmailRow[] };
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

    function applyInsert(row: EmailRow) {
      const entries = qc.getQueriesData<CachedList>({ queryKey: ["emails"] });
      for (const [key] of entries) {
        if (!rowBelongsInList(row, key as unknown[])) continue;
        patchOneQuery(key as unknown[], (rows) => {
          if (rows.some((r) => r.id === row.id)) return null;
          const next = [row, ...rows];
          next.sort((a, b) => {
            const ta = a.received_at ? new Date(a.received_at).getTime() : 0;
            const tb = b.received_at ? new Date(b.received_at).getTime() : 0;
            return tb - ta;
          });
          return next;
        });
      }
    }

    function applyUpdate(row: EmailRow) {
      const entries = qc.getQueriesData<CachedList>({ queryKey: ["emails"] });
      let needsRefetch = false;
      for (const [key, value] of entries) {
        if (!value) continue;
        const rows = Array.isArray(value) ? value : Array.isArray(value.rows) ? value.rows : null;
        if (!rows) continue;
        const present = rows.some((r) => r.id === row.id);
        const belongs = rowBelongsInList(row, key as unknown[]);
        if (present && !belongs) {
          patchOneQuery(key as unknown[], (curr) => curr.filter((r) => r.id !== row.id));
        } else if (present && belongs) {
          patchOneQuery(key as unknown[], (curr) =>
            curr.map((r) => (r.id === row.id ? { ...r, ...row } : r)),
          );
        } else if (!present && belongs) {
          needsRefetch = true;
        }
      }
      if (needsRefetch) {
        Promise.resolve().then(() => qc.invalidateQueries({ queryKey: ["emails"] }));
      }
    }

    function applyDelete(row: { id: string }) {
      const entries = qc.getQueriesData<CachedList>({ queryKey: ["emails"] });
      for (const [key, value] of entries) {
        if (!value) continue;
        const rows = Array.isArray(value) ? value : Array.isArray(value.rows) ? value.rows : null;
        if (!rows || !rows.some((r) => r.id === row.id)) continue;
        patchOneQuery(key as unknown[], (curr) => curr.filter((r) => r.id !== row.id));
      }
    }

    const invalidateFolders = () => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders-full"] });
    };

    // Unread/folder counts now live under their own key (a cheap server-side
    // aggregate), so they're not swept by ["emails"] mutations. Refresh them
    // explicitly whenever an email row changes read/label/folder state.
    const bumpCounts = () => qc.invalidateQueries({ queryKey: ["folder-counts"] });

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
          (payload) => applyInsert(payload.new as EmailRow),
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "emails", filter: userFilter },
          (payload) => applyUpdate(payload.new as EmailRow),
        )
        .on(
          "postgres_changes",
          { event: "DELETE", schema: "public", table: "emails", filter: userFilter },
          (payload) => applyDelete(payload.old as { id: string }),
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "folders", filter: userFilter },
          invalidateFolders,
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            reconnectAttempt = 0;
            // Catch up on anything missed while disconnected.
            qc.invalidateQueries({ queryKey: ["emails"] });
            qc.invalidateQueries({ queryKey: ["folders"] });
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
        qc.invalidateQueries({ queryKey: ["emails"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
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
