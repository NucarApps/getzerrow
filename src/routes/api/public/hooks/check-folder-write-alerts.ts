// Alert evaluator for folder_example_write failure spikes.
//
// Folder learning silently degraded once before (a dropped column caused every
// insert_folder_example_encrypted call to 42703). This endpoint turns the
// durable folder_write_failures log into a paging signal: every 5 minutes it
// counts recent failures grouped by (error_code, folder_id), and pages the
// moment any group crosses the threshold — with a cooldown so one incident
// pages once, not on every tick.
//
// USAGE
//   POST /api/public/hooks/check-folder-write-alerts
//     Bearer CRON_SECRET
//   → 200 { ok, checked, fired: [...] }
//
// Paging channel: if ALERT_WEBHOOK_URL is set, a compact JSON payload is POSTed
// there (Slack/Discord/PagerDuty-style incoming webhooks all accept `text`).
// Regardless, a loud `scope:"alert"` structured error line is emitted so
// log-based alerting catches the spike even without a webhook configured.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError, logInfo } from "@/lib/log.server";
import {
  evaluateFolderWriteAlerts,
  type AlertGroup,
  type FailureRow,
  type RecentAlert,
} from "@/lib/folder-write-alerts";

// Tunables. Kept conservative: 3 failures for the same error+folder inside 15
// minutes is well above steady-state (which is zero) but below noise from a
// single transient blip.
const WINDOW_MINUTES = 15;
const THRESHOLD = 3;
const COOLDOWN_MINUTES = 30;
// Bound the failure log so it never grows unbounded.
const RETAIN_DAYS = 7;

async function pageWebhook(groups: AlertGroup[], runId: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const lines = groups.map(
    (g) =>
      `• error_code=${g.error_code} folder_id=${g.folder_id ?? "—"} count=${g.failure_count} (last ${g.last_at})`,
  );
  const text = `🚨 folder_example_write failures spiking (last ${WINDOW_MINUTES}m, run ${runId})\n${lines.join("\n")}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    logError("folder_write_alert.webhook_failed", { run_id: runId }, e);
  }
}

export const Route = createFileRoute("/api/public/hooks/check-folder-write-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("check-folder-write-alerts", async ({ runId }) => {
          const now = Date.now();
          const windowStart = new Date(now - WINDOW_MINUTES * 60_000).toISOString();
          const cooldownStart = new Date(now - COOLDOWN_MINUTES * 60_000).toISOString();

          const { data: failures, error: failErr } = await supabaseAdmin
            .from("folder_write_failures")
            .select("error_code, folder_id, occurred_at")
            .gte("occurred_at", windowStart)
            .order("occurred_at", { ascending: false })
            .limit(5000);
          if (failErr) {
            logError("folder_write_alert.query_failed", { run_id: runId }, failErr);
            return Response.json({ error: failErr.message }, { status: 500 });
          }

          const { data: recent, error: recentErr } = await supabaseAdmin
            .from("folder_write_alerts")
            .select("error_code, folder_id, fired_at")
            .gte("fired_at", cooldownStart);
          if (recentErr) {
            logError("folder_write_alert.recent_query_failed", { run_id: runId }, recentErr);
            return Response.json({ error: recentErr.message }, { status: 500 });
          }

          const toFire = evaluateFolderWriteAlerts(
            (failures ?? []) as FailureRow[],
            (recent ?? []) as RecentAlert[],
            { threshold: THRESHOLD, cooldownMinutes: COOLDOWN_MINUTES, now },
          );

          if (toFire.length > 0) {
            // Loud structured line so log-based paging catches this even with
            // no webhook. Metadata only — no email content.
            logError("alert.folder_example_write_spike", {
              run_id: runId,
              window_minutes: WINDOW_MINUTES,
              threshold: THRESHOLD,
              groups: toFire.map((g) => ({
                error_code: g.error_code,
                folder_id: g.folder_id,
                failure_count: g.failure_count,
                last_at: g.last_at,
              })),
            });

            await supabaseAdmin.from("folder_write_alerts").insert(
              toFire.map((g) => ({
                error_code: g.error_code,
                folder_id: g.folder_id,
                failure_count: g.failure_count,
                window_minutes: WINDOW_MINUTES,
              })),
            );

            await pageWebhook(toFire, runId);
          }

          // Best-effort retention: prune old failure rows so the log stays small.
          const retainBefore = new Date(now - RETAIN_DAYS * 86_400_000).toISOString();
          await supabaseAdmin
            .from("folder_write_failures")
            .delete()
            .lt("occurred_at", retainBefore);

          logInfo("folder_write_alert.checked", {
            run_id: runId,
            window_minutes: WINDOW_MINUTES,
            failures: failures?.length ?? 0,
            fired: toFire.length,
          });

          return Response.json({
            ok: true,
            checked: failures?.length ?? 0,
            window_minutes: WINDOW_MINUTES,
            threshold: THRESHOLD,
            fired: toFire.map((g) => ({
              error_code: g.error_code,
              folder_id: g.folder_id,
              failure_count: g.failure_count,
            })),
            run_id: runId,
          });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
