import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";
import { processContactEnrichJobs } from "@/lib/contacts/enrich-jobs.server";

// Worker for the contact_enrich_jobs queue (cron, every 2 minutes). Claims
// a small batch via claim_contact_enrich_jobs (SKIP LOCKED + 5min lease):
// bio jobs run the AI identity briefing for one contact; suggest jobs run
// the AI grouping scan and the deterministic auto-apply gate.
export const Route = createFileRoute("/api/public/hooks/run-contact-enrich-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("run-contact-enrich-jobs", async ({ runId }) => {
          try {
            // ≤10 jobs per tick; each bio is one short AI call, a suggest
            // job can take ~60s.
            const result = await processContactEnrichJobs(10);
            return new Response(JSON.stringify({ ...result, run_id: runId }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            logError("contact_enrich.tick_failed", { run_id: runId }, e);
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
