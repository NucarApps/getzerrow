import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";
import { enqueueContactEnrichment } from "@/lib/contacts/enrich-jobs.server";

// Enqueue pass for background contact enrichment (cron, every 15 minutes):
// selects contacts that need an AI bio (new or stale-with-fresh-mail) and
// users due for a group-suggestion scan, and inserts contact_enrich_jobs.
export const Route = createFileRoute("/api/public/hooks/enqueue-contact-enrichment")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("enqueue-contact-enrichment", async ({ runId }) => {
          try {
            const result = await enqueueContactEnrichment();
            return new Response(JSON.stringify({ ...result, run_id: runId }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            logError("contact_enrich.enqueue_failed", { run_id: runId }, e);
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
