// Polling fallback — call from cron every 1-2 min.
// Also: detects Pub/Sub silence per-account and auto re-arms the Gmail
// watch. Drains a larger batch of message_jobs at the end so processing
// keeps moving even if the dedicated jobs cron isn't running yet.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory, runMessageJobs } from "@/lib/sync.server";
import { ensureWatch } from "@/lib/gmail.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

// Per-account silence threshold. If the cron has been running but a given
// account hasn't had a single history event (push *or* poll-driven) in 2h,
// the watch is suspect — far tighter than the previous global 6h check.
const PER_ACCOUNT_SILENCE_MS = 2 * 60 * 60 * 1000;
// Cap how often we re-arm any one account so a broken topic doesn't loop.
const REARM_COOLDOWN_MS = 30 * 60 * 1000;

export const Route = createFileRoute("/api/public/gmail-poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("gmail-poll", async ({ runId }) => {
        const { data: accounts, error } = await supabaseAdmin
          .from("gmail_accounts")
          .select("id, email_address, watch_expiration, last_push_at, created_at, needs_reconnect");
        if (error) {
          logError("poll.accounts_query_failed", { run_id: runId }, error);
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        // Look up last successful watch re-arm so we don't spam ensureWatch.
        const { data: recentRearms } = await supabaseAdmin
          .from("pubsub_events")
          .select("email_address, received_at")
          .eq("event_type", "watch_rearm_auto")
          .gte("received_at", new Date(Date.now() - REARM_COOLDOWN_MS).toISOString());
        const rearmedRecently = new Set<string>(
          (recentRearms ?? []).map((r) => r.email_address ?? "").filter(Boolean),
        );

        let ok = 0;
        let failed = 0;
        let rearmedCount = 0;
        let totalAccounts = 0;
        let totalSynced = 0;
        let firstError: string | null = null;
        for (const acc of accounts ?? []) {
          // Skip dead-OAuth accounts — getAccessToken would throw a
          // NeedsReconnectError, burning a slot in the per-tick loop with
          // nothing the cron can fix. The UI banner is the recovery path.
          if (acc.needs_reconnect) continue;
          const lastPushMs = acc.last_push_at ? new Date(acc.last_push_at).getTime() : null;
          const accountAgeMs = acc.created_at ? Date.now() - new Date(acc.created_at).getTime() : 0;
          const accountSilent = lastPushMs !== null
            ? Date.now() - lastPushMs > PER_ACCOUNT_SILENCE_MS
            : accountAgeMs > PER_ACCOUNT_SILENCE_MS;
          const watchActive = acc.watch_expiration && new Date(acc.watch_expiration).getTime() > Date.now();
          const cooldownOver = !rearmedRecently.has(acc.email_address);

          if (accountSilent && watchActive && cooldownOver) {
            const tRearm = Date.now();
            try {
              const w = await ensureWatch(acc.id, null);
              if (w) {
                await supabaseAdmin.from("gmail_accounts").update({
                  history_id: w.historyId,
                  watch_expiration: new Date(parseInt(w.expiration, 10)).toISOString(),
                }).eq("id", acc.id);
                rearmedCount++;
                try {
                  await supabaseAdmin.from("pubsub_events").insert({
                    event_type: "watch_rearm_auto",
                    email_address: acc.email_address,
                    history_id: w.historyId,
                    details: `Per-account silence > ${PER_ACCOUNT_SILENCE_MS / 60_000}min`,
                  });
                } catch (e) {
                  logError("poll.pubsub_log_failed", { run_id: runId, account_id: acc.id, kind: "watch_rearm_auto" }, e);
                }
              }
            } catch (e) {
              logError("poll.self_heal_rearm_failed", {
                run_id: runId,
                account_id: acc.id,
                duration_ms: Date.now() - tRearm,
              }, e);
            }
          }
          const tSync = Date.now();
          try {
            const r = await syncSinceHistory(acc.id);
            const synced = (r as { synced?: number })?.synced ?? 0;
            totalAccounts++;
            totalSynced += synced;
            ok++;
          } catch (e: unknown) {
            const err = e as Error;
            logError("poll.sync_failed", {
              run_id: runId,
              account_id: acc.id,
              attempt: 1,
              duration_ms: Date.now() - tSync,
            }, err);
            const msg = err?.message ?? String(e);
            if (!firstError) firstError = msg;
            failed++;
          }
        }

        // Record this poll run so the Sync activity panel reflects it.
        try {
          await supabaseAdmin.from("pubsub_events").insert({
            event_type: "poll",
            accounts_matched: totalAccounts,
            synced_count: totalSynced,
            error: firstError,
          });
        } catch (e) {
          logError("poll.pubsub_log_failed", { run_id: runId, kind: "poll" }, e);
        }

        // Drain a larger batch of due jobs so processing keeps moving even
        // without the dedicated 30s jobs cron.
        let jobs: Awaited<ReturnType<typeof runMessageJobs>> | null = null;
        const tDrain = Date.now();
        try {
          jobs = await runMessageJobs(50);
        } catch (e) {
          logError("poll.drain_jobs_failed", {
            run_id: runId,
            duration_ms: Date.now() - tDrain,
          }, e);
        }

        return Response.json({
          ok: true,
          count: ok + failed,
          accounts: ok + failed,
          succeeded: ok,
          failed,
          rearmed: rearmedCount,
          synced: totalSynced,
          jobs,
          run_id: runId,
        });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
