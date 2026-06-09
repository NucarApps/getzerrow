// Cron endpoint: advances active backfill_jobs (lists more Gmail IDs
// into message_jobs, or flips status to "done" once the queue drains).
import { createFileRoute } from "@tanstack/react-router";
import { tickBackfillJobs } from "@/lib/sync.server";
import { cronHandler, clampIntParam } from "@/lib/cron-handler.server";

export const Route = createFileRoute("/api/public/gmail-backfill-tick")({
  server: {
    handlers: {
      POST: cronHandler("gmail-backfill-tick", async ({ url }) => {
        const limit = clampIntParam(url, "limit", 1, 10, 2);
        return await tickBackfillJobs(limit);
      }),
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
