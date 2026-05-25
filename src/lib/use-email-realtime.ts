import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type EmailRow = {
  id: string;
  user_id: string;
  gmail_message_id: string;
  received_at: string | null;
  is_archived: boolean | null;
  folder_id: string | null;
  [key: string]: unknown;
};

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

    // Heuristic: do we believe `row` belongs in the list identified by
    // `queryKey`? We inspect the key shape — without server-side knowledge
    // of the query's filters we conservatively reject any list whose key
    // hints at a scope (folder id, "archived", etc.) that doesn't match
    // the row. The top-level ["emails"] list is treated as the all-inbox
    // view and accepts everything.
    function rowBelongsInList(row: EmailRow, queryKey: unknown[]): boolean {
      if (queryKey.length <= 1) return true;
      const tag = queryKey[1];
      if (typeof tag === "string") {
        if (tag === "all") return true;
        if (tag === "archived") return row.is_archived === true;
        if (tag === "inbox") return row.is_archived !== true && row.folder_id == null;
        // Any other string segment is treated as a folder id.
        return row.folder_id === tag;
      }
      return false;
    }

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
          // Row was here but no longer belongs — drop it. The destination
          // list will pick it up via its own INSERT event (if it's cached).
          patchOneQuery(key as unknown[], (curr) => curr.filter((r) => r.id !== row.id));
        } else if (present && belongs) {
          patchOneQuery(key as unknown[], (curr) => curr.map((r) => (r.id === row.id ? { ...r, ...row } : r)));
        } else if (!present && belongs) {
          // Row newly belongs in this list — refetch so we get correct order.
          needsRefetch = true;
        }
      }
      if (needsRefetch) {
        // Run AFTER the synchronous setQueryData calls above so React Query
        // isn't re-entered mid-mutation.
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

    async function connect() {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session || cancelled) return;

      // Make sure the realtime socket carries the user's JWT so RLS allows row payloads.
      try {
        supabase.realtime.setAuth(session.access_token);
      } catch {
        // older clients may not need this; ignore.
      }

      const userFilter = `user_id=eq.${session.user.id}`;
      channel = supabase
        .channel(`inbox-rt-${session.user.id}`)
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
        .subscribe();
    }

    function teardown() {
      if (channel) {
        supabase.removeChannel(channel);
        channel = null;
      }
    }

    connect();

    // Reconnect when the session changes (login, token refresh, sign-out).
    const { data: authSub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN" && event !== "SIGNED_OUT") return;
      teardown();
      connect();
    });

    // Catch-up on tab visibility: realtime websockets can quietly drop after a
    // long sleep. visibilitychange fires for both tab-focus and tab-hide; only
    // refetch on the "visible" transition. (Old version ALSO listened for
    // `focus`, which double-fired on tab switch.)
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        qc.invalidateQueries({ queryKey: ["emails"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      teardown();
      authSub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [qc]);
}
