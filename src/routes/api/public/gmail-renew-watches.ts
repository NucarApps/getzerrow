// Watch renewal — bump any gmail_accounts whose watch expires within 72h. Cron
// should be configured to run every 6h: one missed run won't lapse a watch
// (Gmail watch TTL is 7 days, ensureWatch tolerates re-arm). Logs accounts
// that remain near-expiry after renewal so they're easy to alert on.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureWatch } from "@/lib/gmail.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

const RENEW_WINDOW_HOURS = 72;
const ALERT_NEAR_EXPIRY_HOURS = 24;

export const Route = createFileRoute("/api/public/gmail-renew-watches")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("gmail-renew-watches", async ({ runId }) => {
          const cutoff = new Date(Date.now() + RENEW_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
          const { data: accounts, error } = await supabaseAdmin
            .from("gmail_accounts")
            .select("id, email_address, watch_expiration, needs_reconnect")
            .eq("needs_reconnect", false)
            .or(`watch_expiration.is.null,watch_expiration.lt.${cutoff}`);
          if (error) {
            logError("renew_watches.query_failed", { run_id: runId }, error);
            return Response.json({ ok: false, error: "Query failed" }, { status: 500 });
          }

          let ok = 0;
          let failed = 0;
          const errorSummaries: string[] = [];
          for (const acc of accounts ?? []) {
            const tAcc = Date.now();
            try {
              const w = await ensureWatch(acc.id, null); // force renew
              if (w) {
                await supabaseAdmin
                  .from("gmail_accounts")
                  .update({
                    history_id: w.historyId,
                    watch_expiration: new Date(parseInt(w.expiration, 10)).toISOString(),
                  })
                  .eq("id", acc.id);
              }
              ok++;
            } catch (e: unknown) {
              const msg = (e as Error)?.message ?? String(e);
              logError(
                "renew_watches.account_failed",
                {
                  run_id: runId,
                  account_id: acc.id,
                  duration_ms: Date.now() - tAcc,
                },
                e,
              );
              failed++;
              if (errorSummaries.length < 5) errorSummaries.push(msg);
            }
          }

          const nearExpiryCutoff = new Date(
            Date.now() + ALERT_NEAR_EXPIRY_HOURS * 60 * 60 * 1000,
          ).toISOString();
          const stillExpiring =
            (accounts?.length ?? 0) > 0
              ? (
                  await supabaseAdmin
                    .from("gmail_accounts")
                    .select("id, email_address, watch_expiration")
                    .or(`watch_expiration.is.null,watch_expiration.lt.${nearExpiryCutoff}`)
                ).data
              : [];
          for (const acc of stillExpiring ?? []) {
            try {
              await supabaseAdmin.from("pubsub_events").insert({
                event_type: "watch_renew_failed",
                email_address: acc.email_address,
                details: `Watch expiration ${acc.watch_expiration ?? "<null>"} still inside ${ALERT_NEAR_EXPIRY_HOURS}h after renewal pass`,
              });
            } catch (e) {
              logError(
                "renew_watches.pubsub_log_failed",
                { run_id: runId, account_id: acc.id, kind: "watch_renew_failed" },
                e,
              );
            }
          }

          try {
            await supabaseAdmin.from("pubsub_events").insert({
              event_type: "watch_renew",
              accounts_matched: ok + failed,
              synced_count: ok,
              error: errorSummaries.join("; ") || null,
              details: `Renewed ${ok}/${ok + failed}; ${stillExpiring?.length ?? 0} still near-expiry`,
            });
          } catch (e) {
            logError("renew_watches.pubsub_log_failed", { run_id: runId, kind: "watch_renew" }, e);
          }
          return Response.json({
            ok: true,
            count: ok + failed,
            succeeded: ok,
            failed,
            stillExpiring: stillExpiring?.length ?? 0,
            run_id: runId,
          });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
