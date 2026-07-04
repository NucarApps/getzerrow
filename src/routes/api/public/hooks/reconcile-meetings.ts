// Cron tick: reconcile non-terminal meetings against Recall as a webhook
// fallback. Picks up recordings/transcripts even if a webhook was missed.
//
//   POST /api/public/hooks/reconcile-meetings   (Bearer CRON_SECRET)
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { syncMeetingFromRecall } from "@/lib/meetings.server";
import { logError, logInfo, newRunId } from "@/lib/log.server";

// Only reconcile bots that were expected to be active recently, so we don't
// poll far-future scheduled meetings on every tick.
const MAX_PER_RUN = 25;

export const Route = createFileRoute("/api/public/hooks/reconcile-meetings")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        const runId = newRunId();
        try {
          const cutoff = new Date(Date.now() + 5 * 60_000).toISOString();
          const { data: meetings } = await supabaseAdmin
            .from("meetings")
            .select("id, user_id, recall_bot_id, status")
            .not("recall_bot_id", "is", null)
            .in("status", ["scheduled", "joining", "recording"])
            .or(`scheduled_start.is.null,scheduled_start.lte.${cutoff}`)
            .order("updated_at", { ascending: true })
            .limit(MAX_PER_RUN);

          let reconciled = 0;
          for (const m of meetings ?? []) {
            await syncMeetingFromRecall(m);
            reconciled++;
          }
          logInfo("reconcile_meetings_done", { runId, reconciled });
          return Response.json({ ok: true, reconciled });
        } catch (e) {
          logError("reconcile_meetings_failed", { runId }, e);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
