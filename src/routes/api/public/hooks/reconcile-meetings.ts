// Cron tick: reconcile non-terminal meetings against Recall as a webhook
// fallback. Picks up recordings/transcripts even if a webhook was missed.
//
//   POST /api/public/hooks/reconcile-meetings   (Bearer CRON_SECRET)
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { syncMeetingFromRecall, loadBotConfig } from "@/lib/meetings.server";
import { leaveBot } from "@/lib/recall.server";
import { logError, logInfo, newRunId } from "@/lib/log.server";

// Only reconcile bots that were expected to be active recently, so we don't
// poll far-future scheduled meetings on every tick.
const MAX_PER_RUN = 25;
// Extra margin on top of the user's configured auto-leave window before the
// cron force-leaves a stuck bot itself, so Recall's own timeout gets first go.
const FORCE_LEAVE_GRACE_MIN = 5;

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
            .select(
              "id, user_id, recall_bot_id, status, title, started_at, scheduled_start, created_at",
            )
            .not("recall_bot_id", "is", null)
            .in("status", ["scheduled", "joining", "recording"])
            .or(`scheduled_start.is.null,scheduled_start.lte.${cutoff}`)
            .order("updated_at", { ascending: true })
            .limit(MAX_PER_RUN);

          // Cache per-user bot config so we don't reload it per meeting.
          const configCache = new Map<string, Awaited<ReturnType<typeof loadBotConfig>>>();
          let reconciled = 0;
          let forcedLeaves = 0;
          for (const m of meetings ?? []) {
            // Backstop: force-leave a bot stuck in an active state past the
            // user's auto-leave window (+ grace), even if Recall missed it.
            if (m.recall_bot_id && (m.status === "joining" || m.status === "recording")) {
              let cfg = configCache.get(m.user_id);
              if (!cfg) {
                cfg = await loadBotConfig(m.user_id);
                configCache.set(m.user_id, cfg);
              }
              if (cfg.autoLeaveEnabled) {
                const startRef = m.started_at ?? m.scheduled_start ?? m.created_at;
                const ageMin = startRef
                  ? (Date.now() - new Date(startRef).getTime()) / 60_000
                  : 0;
                if (ageMin >= cfg.autoLeaveMinutes + FORCE_LEAVE_GRACE_MIN) {
                  try {
                    await leaveBot(m.recall_bot_id);
                    forcedLeaves++;
                  } catch (e) {
                    logError("reconcile_force_leave_failed", { runId, id: m.id }, e);
                  }
                }
              }
            }
            await syncMeetingFromRecall(m);
            reconciled++;
          }
          logInfo("reconcile_meetings_done", { runId, reconciled, forcedLeaves });
          return Response.json({ ok: true, reconciled, forcedLeaves });
        } catch (e) {
          logError("reconcile_meetings_failed", { runId }, e);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
