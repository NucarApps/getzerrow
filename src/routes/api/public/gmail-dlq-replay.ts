// Auto-replay DLQ jobs whose last_error looks transient (5xx, 429, timeout,
// network reset) and pick up any forward-to retries that are due. Cron this
// every 5-10 minutes so a brief Gmail outage doesn't leave hundreds of
// messages parked until an operator manually clicks "retry".
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { replayTransientDlq, retryForwardAttempts } from "@/lib/sync.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/gmail-dlq-replay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        const url = new URL(request.url);
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200", 10) || 200, 500);
        const forwardLimit = Math.min(parseInt(url.searchParams.get("forwardLimit") ?? "50", 10) || 50, 200);

        let dlq: Awaited<ReturnType<typeof replayTransientDlq>> | null = null;
        let forwards: Awaited<ReturnType<typeof retryForwardAttempts>> | null = null;
        let dlqError: string | null = null;
        let forwardError: string | null = null;

        try { dlq = await replayTransientDlq(limit); }
        catch (e) {
          console.error("replayTransientDlq failed", e);
          dlqError = (e as Error)?.message ?? String(e);
        }
        try { forwards = await retryForwardAttempts(forwardLimit); }
        catch (e) {
          console.error("retryForwardAttempts failed", e);
          forwardError = (e as Error)?.message ?? String(e);
        }

        try {
          await supabaseAdmin.from("pubsub_events").insert({
            event_type: "dlq_replay",
            details: `DLQ replayed ${dlq?.replayed ?? 0}/${dlq?.checked ?? 0}; forwards ok=${forwards?.ok ?? 0} failed=${forwards?.failed ?? 0} gaveUp=${forwards?.gaveUp ?? 0}`,
            error: dlqError ?? forwardError,
          });
        } catch (e) { console.error("pubsub_events dlq_replay log failed", e); }

        return Response.json({ ok: true, dlq, forwards });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
