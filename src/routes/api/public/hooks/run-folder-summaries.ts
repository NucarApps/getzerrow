import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runFolderSummary } from "@/lib/summaries.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/hooks/run-folder-summaries")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();

        const { data: due, error } = await supabaseAdmin
          .from("folder_summary_schedules")
          .select("id")
          .eq("enabled", true)
          .lte("next_run_at", new Date().toISOString())
          .order("next_run_at", { ascending: true })
          .limit(25);
        if (error) {
          return new Response(JSON.stringify({ error: error.message }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }

        let succeeded = 0;
        let failed = 0;
        for (const row of due ?? []) {
          try {
            const r = await runFolderSummary(row.id);
            if (r.ok) succeeded++; else failed++;
          } catch (e) {
            console.error("hook iteration crashed", row.id, e);
            failed++;
          }
        }
        return new Response(
          JSON.stringify({ processed: due?.length ?? 0, succeeded, failed }),
          { headers: { "Content-Type": "application/json" } }
        );
      },
    },
  },
});
