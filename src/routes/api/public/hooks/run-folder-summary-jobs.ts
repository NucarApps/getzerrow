import { createFileRoute } from "@tanstack/react-router";
import { processFolderSummaryJobs } from "@/lib/summaries.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

// Background worker that processes the folder_summary_jobs queue. Each tick
// claims a small batch (SKIP LOCKED + 5min lease via claim_folder_summary_jobs)
// and runs the digest end-to-end so the user request never blocks on AI.
export const Route = createFileRoute("/api/public/hooks/run-folder-summary-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("run-folder-summary-jobs", async ({ runId }) => {
          try {
            // Process up to 3 jobs per tick — each can take ~60–90s of AI time.
            const result = await processFolderSummaryJobs(3);
            return new Response(
              JSON.stringify({ ...result, run_id: runId }),
              { headers: { "Content-Type": "application/json" } },
            );
          } catch (e) {
            logError("folder_summary_jobs.tick_failed", { run_id: runId }, e);
            return new Response(
              JSON.stringify({ error: (e as Error)?.message ?? "Failed" }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            );
          }
        });
      },
    },
  },
});
