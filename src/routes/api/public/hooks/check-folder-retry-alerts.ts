// Alert evaluator for elevated folder_example_write RETRY rates.
//
// The failure-spike alert (check-folder-write-alerts) only fires when writes
// fail outright. But a write that fails transiently and then SUCCEEDS on retry
// leaves no failure record — learning still works, so that alert stays silent.
// A rising retry rate is the earlier signal that the database is getting flaky.
// This endpoint turns the durable folder_write_retries log into a paging
// signal: every 5 minutes it counts recent retried writes grouped by folder,
// and pages the moment any folder crosses the threshold — with a cooldown so
// one incident pages once, not on every tick.
//
// USAGE
//   POST /api/public/hooks/check-folder-retry-alerts
//     Bearer CRON_SECRET
//   → 200 { ok, checked, fired: [...] }
//
// Paging channel: if ALERT_WEBHOOK_URL is set, a compact JSON payload is POSTed
// there (Slack/Discord/PagerDuty-style incoming webhooks accept `text`).
// Regardless, a loud `scope:"alert"` structured error line is emitted so
// log-based alerting catches the spike even without a webhook configured.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError, logInfo } from "@/lib/log.server";
import {
  evaluateFolderRetryAlerts,
  type RetryAlertGroup,
  type RetryRow,
  type RecentRetryAlert,
} from "@/lib/folder-retry-alerts";

// Tunables. Retries should be near-zero in steady state, so 3 retried writes
// for the same folder inside 15 minutes is a meaningful instability signal
// while staying above the odd single blip.
const WINDOW_MINUTES = 15;
const THRESHOLD = 3;
const COOLDOWN_MINUTES = 30;
// Bound the retry log so it never grows unbounded.
const RETAIN_DAYS = 7;

async function pageWebhook(groups: RetryAlertGroup[], runId: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const lines = groups.map(
    (g) =>
      `• folder_id=${g.folder_id ?? "—"} retries=${g.retry_count} failed=${g.failed_count} max_attempts=${g.max_attempts} (last ${g.last_at})`,
  );
  const text = `⚠️ folder_example_write retry rate elevated (last ${WINDOW_MINUTES}m, run ${runId})\n${lines.join("\n")}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    logError("folder_retry_alert.webhook_failed", { run_id: runId }, e);
  }
}

export const Route = createFileRoute("/api/public/hooks/check-folder-retry-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("check-folder-retry-alerts", async ({ runId }) => {
          const now = Date.now();
          const windowStart = new Date(now - WINDOW_MINUTES * 60_000).toISOString();
          const cooldownStart = new Date(now - COOLDOWN_MINUTES * 60_000).toISOString();

          const { data: retries, error: retryErr } = await supabaseAdmin
            .from("folder_write_retries")
            .select("folder_id, occurred_at, attempts, outcome")
            .gte("occurred_at", windowStart)
            .order("occurred_at", { ascending: false })
            .limit(5000);
          if (retryErr) {
            logError("folder_retry_alert.query_failed", { run_id: runId }, retryErr);
            return Response.json({ error: retryErr.message }, { status: 500 });
          }

          const { data: recent, error: recentErr } = await supabaseAdmin
            .from("folder_retry_alerts")
            .select("folder_id, fired_at")
            .gte("fired_at", cooldownStart);
          if (recentErr) {
            logError("folder_retry_alert.recent_query_failed", { run_id: runId }, recentErr);
            return Response.json({ error: recentErr.message }, { status: 500 });
          }

          const toFire = evaluateFolderRetryAlerts(
            (retries ?? []) as RetryRow[],
            (recent ?? []) as RecentRetryAlert[],
            { threshold: THRESHOLD, cooldownMinutes: COOLDOWN_MINUTES, now },
          );

          if (toFire.length > 0) {
            // Loud structured line so log-based paging catches this even with
            // no webhook. Metadata only — no email content.
            logError("alert.folder_example_write_retry_spike", {
              run_id: runId,
              window_minutes: WINDOW_MINUTES,
              threshold: THRESHOLD,
              groups: toFire.map((g) => ({
                folder_id: g.folder_id,
                retry_count: g.retry_count,
                failed_count: g.failed_count,
                max_attempts: g.max_attempts,
                last_at: g.last_at,
              })),
            });

            await supabaseAdmin.from("folder_retry_alerts").insert(
              toFire.map((g) => ({
                folder_id: g.folder_id,
                retry_count: g.retry_count,
                window_minutes: WINDOW_MINUTES,
              })),
            );

            await pageWebhook(toFire, runId);
          }

          // Best-effort retention: prune old retry rows so the log stays small.
          const retainBefore = new Date(now - RETAIN_DAYS * 86_400_000).toISOString();
          await supabaseAdmin.from("folder_write_retries").delete().lt("occurred_at", retainBefore);

          logInfo("folder_retry_alert.checked", {
            run_id: runId,
            window_minutes: WINDOW_MINUTES,
            retries: retries?.length ?? 0,
            fired: toFire.length,
          });

          return Response.json({
            ok: true,
            checked: retries?.length ?? 0,
            window_minutes: WINDOW_MINUTES,
            threshold: THRESHOLD,
            fired: toFire.map((g) => ({
              folder_id: g.folder_id,
              retry_count: g.retry_count,
              failed_count: g.failed_count,
              max_attempts: g.max_attempts,
            })),
            run_id: runId,
          });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
