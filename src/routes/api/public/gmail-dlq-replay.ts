// Auto-replay DLQ jobs whose last_error looks transient (5xx, 429, timeout,
// network reset) and pick up any forward-to retries that are due. Cron this
// every 5-10 minutes so a brief Gmail outage doesn't leave hundreds of
// messages parked until an operator manually clicks "retry".
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { replayTransientDlq, retryForwardAttempts } from "@/lib/sync.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/gmail-dlq-replay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("gmail-dlq-replay", async ({ runId }) => {
          const url = new URL(request.url);
          const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);
          const forwardLimit = Math.min(
            parseInt(url.searchParams.get("forwardLimit") ?? "50", 10) || 50,
            200,
          );

          let dlq: Awaited<ReturnType<typeof replayTransientDlq>> | null = null;
          let forwards: Awaited<ReturnType<typeof retryForwardAttempts>> | null = null;
          let dlqError: string | null = null;
          let forwardError: string | null = null;

          const tDlq = Date.now();
          try {
            dlq = await replayTransientDlq(limit);
          } catch (e) {
            logError(
              "dlq_replay.replay_failed",
              {
                run_id: runId,
                limit,
                duration_ms: Date.now() - tDlq,
              },
              e,
            );
            dlqError = (e as Error)?.message ?? String(e);
          }
          const tFwd = Date.now();
          try {
            forwards = await retryForwardAttempts(forwardLimit);
          } catch (e) {
            logError(
              "dlq_replay.forward_retry_failed",
              {
                run_id: runId,
                forward_limit: forwardLimit,
                duration_ms: Date.now() - tFwd,
              },
              e,
            );
            forwardError = (e as Error)?.message ?? String(e);
          }

          try {
            await supabaseAdmin.from("pubsub_events").insert({
              event_type: "dlq_replay",
              details: `DLQ replayed ${dlq?.replayed ?? 0}/${dlq?.checked ?? 0}; forwards ok=${forwards?.ok ?? 0} failed=${forwards?.failed ?? 0} gaveUp=${forwards?.gaveUp ?? 0}`,
              error: dlqError ?? forwardError,
            });
          } catch (e) {
            logError("dlq_replay.pubsub_log_failed", { run_id: runId }, e);
          }

          return Response.json({ ok: true, dlq, forwards, run_id: runId });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
