import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";
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
            return new Response(JSON.stringify({ ...result, run_id: runId }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            logError("scheduled_actions.tick_failed", { run_id: runId }, e);
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
