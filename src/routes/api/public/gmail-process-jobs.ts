// Worker endpoint: drains the message_jobs queue. Call from cron every
// 30s (mixed queue) and every ~5s with ?priority=0 (live-only lane).
import { createFileRoute } from "@tanstack/react-router";
import { runMessageJobs } from "@/lib/sync.server";
import { cronHandler, clampIntParam, optionalIntParam } from "@/lib/cron-handler.server";

export const Route = createFileRoute("/api/public/gmail-process-jobs")({
  server: {
    handlers: {
      POST: cronHandler("gmail-process-jobs", async ({ url }) => {
        const limit = clampIntParam(url, "limit", 1, 200, 100);
        const priority = optionalIntParam(url, "priority", 0, 99);
        return await runMessageJobs(limit, 16, { priority });
      }),
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
