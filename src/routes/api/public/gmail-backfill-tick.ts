// Cron endpoint: advances active backfill_jobs (lists more Gmail IDs into
// message_jobs, or flips status to "done" once the queue drains).
import { createFileRoute } from "@tanstack/react-router";
import { tickBackfillJobs } from "@/lib/sync.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/gmail-backfill-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("gmail-backfill-tick", async ({ runId }) => {
          const url = new URL(request.url);
          const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "2", 10) || 2, 10);
          const t0 = Date.now();
          try {
            const r = await tickBackfillJobs(limit);
            return Response.json({ ok: true, ...r, run_id: runId });
          } catch (e: unknown) {
            logError("backfill_tick.failed", {
              run_id: runId,
              limit,
              duration_ms: Date.now() - t0,
            }, e);
            return Response.json({ ok: false, error: "Backfill tick failed", run_id: runId }, { status: 500 });
          }
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
