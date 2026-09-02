import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { createRealtimeConnection } from "@/lib/ui/realtime-coalescer";

/**
 * Live feed for the Contacts book. Shares useEmailRealtime's connection
 * handling (re-auth, reconnect with backoff, catch-up on visibility) via
 * createRealtimeConnection, but is invalidation-only: contact rows are small
 * and the list query is cheap, so any INSERT/UPDATE/DELETE on the signed-in
 * user's contacts simply marks the contact queries stale and React Query
 * re-fetches the ones on screen.
 *
 * This is what makes a business card scanned on the iPhone appear on an open
 * web Contacts page within a second or two — no reload.
 */
export function useContactsRealtime() {
  const qc = useQueryClient();

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const refresh = () => {
      qc.invalidateQueries({ queryKey: ["contacts"] });
      // Open detail views use ["contact", id] — without this, a cross-device
      // edit (iPhone CardDAV, Google sync, card scan) updates the list but
      // leaves an already-open drawer showing stale fields.
      qc.invalidateQueries({ queryKey: ["contact"] });
      qc.invalidateQueries({ queryKey: ["contact-groups"] });
      // Company buckets are derived from contacts' company fields.
      qc.invalidateQueries({ queryKey: ["companies"] });
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

    const clearDebounce = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const connection = createRealtimeConnection<ReturnType<typeof supabase.channel>>({
      channelPrefix: "contacts-rt",
      async session() {
        const { data } = await supabase.auth.getSession();
        const s = data.session;
        return s ? { accessToken: s.access_token, userId: s.user.id } : null;
      },
      setAuth: (token) => supabase.realtime.setAuth(token),
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
            { event: "*", schema: "public", table: "contacts", filter: userFilter },
            onChange,
          )
          .subscribe(onStatus),
      // Catch up on anything missed while disconnected.
      onSubscribed: refresh,
      onTeardown: clearDebounce,
      // The list query is cheap enough to just re-run on focus; the inbox
      // pays for a liveness check instead because its refetch decrypts.
      onVisible: () => refresh(),
    });

    connection.start();

    return () => {
      connection.stop();
    };
  }, [qc]);
}
