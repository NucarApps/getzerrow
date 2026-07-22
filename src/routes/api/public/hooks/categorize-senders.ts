import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";
import { logCronRunEvent } from "@/lib/sync/cron-run-log.server";
import { categorizeSenders } from "@/lib/contacts/categorize-senders.server";

// Nightly AI sender categorization (rules upgrade, task 7): labels recent
// uncategorized senders per user with a fixed category set and maintains
// kind='ai_category' contact groups so folder rules can target them via
// the existing sender_in_group op. Fails closed on auth.
export const Route = createFileRoute("/api/public/hooks/categorize-senders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("categorize-senders", async ({ runId }) => {
          try {
            const result = await categorizeSenders();
            // Run log — nightly cadence, so every tick gets a row.
            await logCronRunEvent(
              "categorize_senders_run",
              `run_id=${runId} users=${result.users} labeled=${result.labeled} skipped=${result.skipped}`,
            );
            return new Response(JSON.stringify({ ...result, run_id: runId }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            logError("categorize_senders.tick_failed", { run_id: runId }, e);
            await logCronRunEvent(
              "categorize_senders_run",
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
