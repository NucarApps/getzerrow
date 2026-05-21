// Cron endpoint: advances active backfill_jobs (lists more Gmail IDs into
// message_jobs, or flips status to "done" once the queue drains).
import { createFileRoute } from "@tanstack/react-router";
import { tickBackfillJobs } from "@/lib/sync.server";
import { isAuthorizedCron, unauthorizedResponse } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/gmail-backfill-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorizedCron(request)) return unauthorizedResponse();
        const url = new URL(request.url);
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "2", 10) || 2, 10);
        try {
          const r = await tickBackfillJobs(limit);
          return Response.json({ ok: true, ...r });
        } catch (e: unknown) {
          console.error("tickBackfillJobs failed", e);
          return Response.json({ ok: false, error: "Backfill tick failed" }, { status: 500 });
        }
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
