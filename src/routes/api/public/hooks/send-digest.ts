import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";
import { sendDigests } from "@/lib/sync/digest.server";

// Hourly digest tick (rules upgrade, task 9): sends one summary email
// per user/bucket when the user's local clock hits their digest hour,
// then stamps sent_at on the included rows. Fails closed on auth.
export const Route = createFileRoute("/api/public/hooks/send-digest")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("send-digest", async ({ runId }) => {
          try {
            const result = await sendDigests();
            return new Response(JSON.stringify({ ...result, run_id: runId }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            logError("digest.tick_failed", { run_id: runId }, e);
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
