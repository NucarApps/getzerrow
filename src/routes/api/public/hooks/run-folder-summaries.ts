import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runFolderSummary } from "@/lib/summaries.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/hooks/run-folder-summaries")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("run-folder-summaries", async ({ runId }) => {
          const { data: due, error } = await supabaseAdmin
            .from("folder_summary_schedules")
            .select("id")
            .eq("enabled", true)
            .lte("next_run_at", new Date().toISOString())
            .order("next_run_at", { ascending: true })
            .limit(25);
          if (error) {
            logError("folder_summaries.query_failed", { run_id: runId }, error);
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500, headers: { "Content-Type": "application/json" },
            });
          }

          let succeeded = 0;
          let failed = 0;
          for (const row of due ?? []) {
            const tIter = Date.now();
            try {
              const r = await runFolderSummary(row.id);
              if (r.ok) succeeded++; else failed++;
            } catch (e) {
              logError("folder_summaries.iter_crashed", {
                run_id: runId,
                schedule_id: row.id,
                duration_ms: Date.now() - tIter,
              }, e);
              failed++;
            }
          }
          return new Response(
            JSON.stringify({ processed: due?.length ?? 0, succeeded, failed, run_id: runId }),
            { headers: { "Content-Type": "application/json" } }
          );
        });
      },
    },
  },
});

