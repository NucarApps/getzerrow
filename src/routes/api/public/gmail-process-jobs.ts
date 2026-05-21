// Worker endpoint: drains the message_jobs queue. Call from cron every 30s.
import { createFileRoute } from "@tanstack/react-router";
import { runMessageJobs } from "@/lib/sync.server";
import { isAuthorizedCron, unauthorizedResponse } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/gmail-process-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorizedCron(request)) return unauthorizedResponse();
        const url = new URL(request.url);
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "25", 10) || 25, 100);
        try {
          const r = await runMessageJobs(limit);
          return Response.json({ ...r, ok: true });
        } catch (e: unknown) {
          console.error("runMessageJobs failed", e);
          return Response.json({ ok: false, error: "Job processing failed" }, { status: 500 });
        }
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
