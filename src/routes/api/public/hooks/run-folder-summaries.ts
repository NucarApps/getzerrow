import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { computeNextRun, enqueueFolderSummaryJob } from "@/lib/summaries.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

// Finds folder_summary_schedules whose next_run_at has passed and enqueues
// background jobs for them. The heavy AI work runs in run-folder-summary-jobs
// so this cron tick stays cheap even when many schedules fire at once.
export const Route = createFileRoute("/api/public/hooks/run-folder-summaries")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("run-folder-summaries", async ({ runId }) => {
          const { data: due, error } = await supabaseAdmin
            .from("folder_summary_schedules")
            .select("id, user_id, hour, minute, timezone")
            .eq("enabled", true)
            .lte("next_run_at", new Date().toISOString())
            .order("next_run_at", { ascending: true })
            .limit(25);
          if (error) {
            logError("folder_summaries.query_failed", { run_id: runId }, error);
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }

          let enqueued = 0;
          let failed = 0;
          for (const row of due ?? []) {
            try {
              await enqueueFolderSummaryJob({ scheduleId: row.id, userId: row.user_id });
              // Advance next_run_at immediately so we don't re-enqueue the same
              // schedule on the next tick before the worker has run it.
              await supabaseAdmin
                .from("folder_summary_schedules")
                .update({
                  next_run_at: computeNextRun(row.hour, row.minute, row.timezone).toISOString(),
                })
                .eq("id", row.id);
              enqueued++;
            } catch (e) {
              logError(
                "folder_summaries.enqueue_failed",
                { run_id: runId, schedule_id: row.id },
                e,
              );
              failed++;
            }
          }
          return new Response(
            JSON.stringify({ processed: due?.length ?? 0, enqueued, failed, run_id: runId }),
            { headers: { "Content-Type": "application/json" } },
          );
        });
      },
    },
  },
});
