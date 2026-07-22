import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";
import { logCronRunEvent } from "@/lib/sync/cron-run-log.server";
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
            // Run log (hourly cron — only ticks that actually sent, so
            // the 23 idle hours a day don't flood pubsub_events).
            if (result.sent > 0) {
              await logCronRunEvent(
                "send_digest_run",
                `run_id=${runId} users=${result.users} sent=${result.sent} items=${result.items}`,
              );
            }
            return new Response(JSON.stringify({ ...result, run_id: runId }), {
              headers: { "Content-Type": "application/json" },
            });
          } catch (e) {
            logError("digest.tick_failed", { run_id: runId }, e);
            await logCronRunEvent(
              "send_digest_run",
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
