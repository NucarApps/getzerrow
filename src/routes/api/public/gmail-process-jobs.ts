// Worker endpoint: drains the message_jobs queue. Call from cron every 30s
// (mixed queue) and every ~5s with ?priority=0 (live-only lane).
import { createFileRoute } from "@tanstack/react-router";
import { runMessageJobs } from "@/lib/sync.server";
import { isAuthorizedCron, unauthorizedResponse } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/gmail-process-jobs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorizedCron(request)) return unauthorizedResponse();
        const url = new URL(request.url);
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 200);
        const priorityRaw = url.searchParams.get("priority");
        const priority = priorityRaw !== null && priorityRaw !== ""
          ? Math.max(0, Math.min(parseInt(priorityRaw, 10) || 0, 99))
          : undefined;
        try {
          const r = await runMessageJobs(limit, 16, { priority });
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
