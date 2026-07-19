import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Live feed for the Contacts book. Mirrors useEmailRealtime's connection
 * handling (re-auth, reconnect with backoff, catch-up on visibility) but is
 * invalidation-only: contact rows are small and the list query is cheap, so
 * any INSERT/UPDATE/DELETE on the signed-in user's contacts simply marks the
 * contact queries stale and React Query re-fetches the ones on screen.
 *
 * This is what makes a business card scanned on the iPhone appear on an open
 * web Contacts page within a second or two — no reload.
 */
export function useContactsRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
      qc.invalidateQueries({ queryKey: ["company-aliases"] });
      qc.invalidateQueries({ queryKey: ["company-logo-choices"] });
    };

    // Bulk writes (imports, enrichment sweeps) fire many events at once —
    // trailing debounce so a burst costs one refetch instead of N.
    const onChange = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        refresh();
      }, 300);
    };

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
      const channelId = `contacts-rt-${session.user.id}-${Math.random().toString(36).slice(2, 10)}`;
      channel = supabase
        .channel(channelId)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "contacts", filter: userFilter },
          onChange,
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            reconnectAttempt = 0;
            // Catch up on anything missed while disconnected.
            refresh();
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
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    }

    connect();

    // Re-auth the realtime socket on token refresh and reconnect on
    // sign-in/out — without re-applying the new JWT, RLS-filtered events
    // silently stop flowing after ~an hour.
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
      if (document.visibilityState === "visible") refresh();
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
