// Cron tick: schedule Recall bots for upcoming calendar meetings on accounts
// that enabled auto-record. Runs every few minutes.
//
//   POST /api/public/hooks/schedule-meeting-bots   (Bearer CRON_SECRET)
import { createFileRoute } from "@tanstack/react-router";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { scheduleUpcomingMeetingBots } from "@/lib/meetings-autojoin.server";
import { logError, newRunId } from "@/lib/log.server";

export const Route = createFileRoute("/api/public/hooks/schedule-meeting-bots")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        const runId = newRunId();
        try {
          const r = await scheduleUpcomingMeetingBots(runId);
          return Response.json({ ok: true, ...r });
        } catch (e) {
          logError("schedule_meeting_bots_failed", { runId }, e);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
