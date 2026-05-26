import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { learnFromLinkedLabel, regenerateFolderProfile } from "@/lib/sync.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/hooks/relearn-folders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("relearn-folders", async ({ runId }) => {
          const { data: due, error } = await supabaseAdmin
            .from("folders")
            .select("id, user_id, gmail_label_id, relearn_threshold, emails_since_learn")
            .eq("auto_relearn", true)
            .order("last_learned_at", { ascending: true, nullsFirst: true })
            .limit(50);
          if (error) {
            logError("relearn_folders.query_failed", { run_id: runId }, error);
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500, headers: { "Content-Type": "application/json" },
            });
          }

          const ready = (due ?? []).filter((f) =>
            (f.emails_since_learn ?? 0) >= (f.relearn_threshold ?? 25)
          ).slice(0, 25);

          let succeeded = 0;
          let failed = 0;
          for (const f of ready) {
            const tIter = Date.now();
            try {
              if (f.gmail_label_id) {
                await learnFromLinkedLabel(f.id, f.user_id);
              } else {
                await regenerateFolderProfile(f.id);
              }
              succeeded++;
            } catch (e) {
              logError("relearn_folders.iter_failed", {
                run_id: runId,
                folder_id: f.id,
                user_id: f.user_id,
                has_label: !!f.gmail_label_id,
                duration_ms: Date.now() - tIter,
              }, e);
              failed++;
            }
          }
          return new Response(
            JSON.stringify({ checked: due?.length ?? 0, ran: ready.length, succeeded, failed, run_id: runId }),
            { headers: { "Content-Type": "application/json" } }
          );
        });
      },
    },
  },
});

