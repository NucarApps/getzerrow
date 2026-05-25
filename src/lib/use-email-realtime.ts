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

    // Apply an updater to every cached query that starts with the given prefix.
    // The inbox uses several variants (["emails"], ["emails", folderId], ...)
    // so we patch them all instead of guessing each key.
    function patchEmailQueries(updater: (rows: EmailRow[]) => EmailRow[]) {
      qc.setQueriesData<EmailRow[] | { rows: EmailRow[] } | undefined>(
        { queryKey: ["emails"] },
        (old) => {
          if (!old) return old;
          if (Array.isArray(old)) return updater(old);
          if (Array.isArray((old as { rows?: EmailRow[] }).rows)) {
            return { ...(old as object), rows: updater((old as { rows: EmailRow[] }).rows) };
          }
          return old;
        },
      );
    }

    function applyInsert(row: EmailRow) {
      patchEmailQueries((rows) => {
        if (rows.some((r) => r.id === row.id)) return rows;
        // Maintain newest-first ordering by received_at when available.
        const next = [row, ...rows];
        next.sort((a, b) => {
          const ta = a.received_at ? new Date(a.received_at).getTime() : 0;
          const tb = b.received_at ? new Date(b.received_at).getTime() : 0;
          return tb - ta;
        });
        return next;
      });
    }

    function applyUpdate(row: EmailRow) {
      patchEmailQueries((rows) => {
        let touched = false;
        const next = rows.map((r) => (r.id === row.id ? (touched = true, { ...r, ...row }) : r));
        // If the row was outside our cached window, fall through to a refetch
        // so any cross-list moves (folder change, archive) reconverge.
        if (!touched) {
          qc.invalidateQueries({ queryKey: ["emails"] });
        }
        return next;
      });
    }

    function applyDelete(row: { id: string }) {
      patchEmailQueries((rows) => rows.filter((r) => r.id !== row.id));
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
