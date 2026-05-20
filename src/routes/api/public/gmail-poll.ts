// Polling fallback — call from cron every 1-2 min.
// Also: detects Pub/Sub silence and auto re-arms the Gmail watch when push
// has been quiet for >6h despite an active watch. Drains a small batch of
// message_jobs at the end so processing keeps moving even if the dedicated
// jobs cron isn't running yet.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory, runMessageJobs } from "@/lib/sync.server";
import { ensureWatch } from "@/lib/gmail.server";

const SILENCE_MS = 6 * 60 * 60 * 1000; // 6 hours

export const Route = createFileRoute("/api/public/gmail-poll")({
  server: {
    handlers: {
      POST: async () => {
        const { data: accounts, error } = await supabaseAdmin
          .from("gmail_accounts")
          .select("id, email_address, watch_expiration");
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        // Self-heal: if the last push event was >6h ago (or never) AND any
        // account has an active watch, re-arm the watch.
        const { data: lastPush } = await supabaseAdmin
          .from("pubsub_events")
          .select("received_at")
          .eq("event_type", "push")
          .order("received_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const lastPushAt = lastPush?.received_at ? new Date(lastPush.received_at).getTime() : 0;
        const silent = Date.now() - lastPushAt > SILENCE_MS;

        const results: Array<{ id: string; email: string; ok: boolean; error?: string; rearmed?: boolean }> = [];
        for (const acc of accounts ?? []) {
          let rearmed = false;
          if (silent && acc.watch_expiration && new Date(acc.watch_expiration).getTime() > Date.now()) {
            try {
              const w = await ensureWatch(acc.id, null);
              if (w) {
                await supabaseAdmin.from("gmail_accounts").update({
                  history_id: w.historyId,
                  watch_expiration: new Date(parseInt(w.expiration, 10)).toISOString(),
                }).eq("id", acc.id);
                rearmed = true;
              }
            } catch (e) {
              console.error("self-heal watch re-arm failed", acc.email_address, e);
            }
          }
          try {
            const r = await syncSinceHistory(acc.id);
            results.push({ id: acc.id, email: acc.email_address, ok: true, rearmed, ...r });
          } catch (e: unknown) {
            const err = e as Error;
            console.error("poll failed for", acc.email_address, err);
            results.push({ id: acc.id, email: acc.email_address, ok: false, rearmed, error: err?.message ?? String(e) });
          }
        }

        // Drain a small batch of due jobs so processing keeps moving even
        // without the dedicated 30s jobs cron.
        let jobs: Awaited<ReturnType<typeof runMessageJobs>> | null = null;
        try {
          jobs = await runMessageJobs(25);
        } catch (e) {
          console.error("drain jobs failed", e);
        }

        return Response.json({ ok: true, count: results.length, silent, results, jobs });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
