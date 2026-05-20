import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Single source of truth for inbox realtime + catch-up.
 * - Subscribes to postgres_changes on emails/folders, scoped to the current user.
 * - Re-authenticates the realtime socket so RLS lets payloads through.
 * - Invalidates the relevant React Query keys on every change.
 * - Catches up on tab focus / visibility change (handles dropped websockets after sleep).
 */
export function useEmailRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    const invalidateEmails = () => {
      qc.invalidateQueries({ queryKey: ["emails"] });
    };
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
          { event: "*", schema: "public", table: "emails", filter: userFilter },
          invalidateEmails,
        )
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "folders", filter: userFilter },
          invalidateFolders,
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            // Catch up on anything written between mount and subscription.
            invalidateEmails();
            invalidateFolders();
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

    // Reconnect when the session changes (login, token refresh, sign-out).
    const { data: authSub } = supabase.auth.onAuthStateChange(() => {
      teardown();
      connect();
    });

    // Catch-up refetch when the tab regains focus.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        invalidateEmails();
        invalidateFolders();
      }
    };
    const onFocus = () => {
      invalidateEmails();
      invalidateFolders();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      teardown();
      authSub.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [qc]);
}
