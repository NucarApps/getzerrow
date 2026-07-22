import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";
import { logCronRunEvent } from "@/lib/sync/cron-run-log.server";
import { runScheduledActions } from "@/lib/sync/scheduled-actions";

// Runner for the scheduled_actions queue (cron, every minute). Claims due
// rows via claim_scheduled_actions (SKIP LOCKED + 5-min lease) and
// executes them: signed webhook deliveries and delayed label-type
// actions. Failures reschedule with exponential backoff up to 6 attempts.
export const Route = createFileRoute("/api/public/hooks/run-scheduled-actions")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("run-scheduled-actions", async ({ runId }) => {
          try {
            const result = await runScheduledActions(20);
            // Run log (this cron ticks every minute — only rows with real
            // work, so idle ticks don't flood pubsub_events).
            if (result.claimed > 0) {
              await logCronRunEvent(
                "scheduled_actions_run",
                `run_id=${runId} claimed=${result.claimed} done=${result.done} retried=${result.retried} failed=${result.failed}`,
                result.failed > 0 ? `${result.failed} action(s) failed terminally` : null,
              );
            }
            return new Response(JSON.stringify({ ...result, run_id: runId }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            logError("scheduled_actions.tick_failed", { run_id: runId }, e);
            await logCronRunEvent(
              "scheduled_actions_run",
              `run_id=${runId} tick crashed`,
              (e as Error)?.message?.slice(0, 500) ?? "unknown",
            );
            return new Response(JSON.stringify({ error: (e as Error)?.message ?? "Failed" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        });
      },
    },
  },
});
