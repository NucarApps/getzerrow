// Cron endpoint: re-classifies stranded emails (AI failures, killed
// workers) that the queue's own retry path no longer owns. Runs every
// 10 minutes via pg_cron.
import { createFileRoute } from "@tanstack/react-router";
import { rescueStrandedEmails } from "@/lib/sync.server";
import { cronHandler, clampIntParam } from "@/lib/cron-handler.server";

export const Route = createFileRoute("/api/public/gmail-rescue-classify")({
  server: {
    handlers: {
      POST: cronHandler("gmail-rescue-classify", async ({ url }) => {
        const limit = clampIntParam(url, "limit", 1, 200, 50);
        return await rescueStrandedEmails({ limit });
      }),
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
