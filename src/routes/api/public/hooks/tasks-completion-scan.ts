// Cron tick: scan recent Sent emails and flag open tasks that look done.
//
//   POST /api/public/hooks/tasks-completion-scan   (Bearer CRON_SECRET)
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { scanSentForTaskCompletion } from "@/lib/tasks/completion.server";
import { logError, logInfo, newRunId } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/hooks/tasks-completion-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        const runId = newRunId();
        try {
          const result = await scanSentForTaskCompletion();
          logInfo("tasks_completion_scan_ok", { runId, ...result });
          return new Response(JSON.stringify({ ok: true, runId, ...result }), {
            headers: { "content-type": "application/json" },
          });
        } catch (e) {
          logError("tasks_completion_scan_failed", { runId }, e);
          return new Response(
            JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }),
            { status: 500, headers: { "content-type": "application/json" } },
          );
        }
      },
    },
  },
});
