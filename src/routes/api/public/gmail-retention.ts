// Retention cron — runs daily to prune two unbounded tables:
//   pubsub_events: 1 row per push/poll/cron event. Without retention the
//     table (and its received_at index) grows monotonically forever.
//   message_jobs (status=dlq): every permanent failure parks here. Auto-
//     replay handles transients; truly-dead jobs need eventual cleanup.
//
// Both prune up to a bounded batch per call. The first run after this is
// deployed will leave a backlog; subsequent daily ticks chip away.
//
// Query params (all optional):
//   pubsub_keep_days        retention for normal rows           default 30
//   pubsub_keep_errors_days retention for rows with error set   default 60
//   pubsub_limit            max rows deleted per call           default 5000
//   dlq_keep_days           DLQ retention                       default 30
//   dlq_limit               max DLQ rows deleted per call       default 1000
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";

type CleanupPubsubResult = { deleted: number; kept_errors: number; total_before: number };
type CleanupDlqResult = { deleted: number; total_before: number };
type CleanupRpc = {
  rpc: (
    fn: "cleanup_old_pubsub_events",
    args: { p_keep_days: number; p_keep_errors_days: number; p_batch_limit: number },
  ) => Promise<{ data: CleanupPubsubResult[] | null; error: { message: string } | null }>;
};
type DlqCleanupRpc = {
  rpc: (
    fn: "cleanup_old_dlq_jobs",
    args: { p_keep_days: number; p_batch_limit: number },
  ) => Promise<{ data: CleanupDlqResult[] | null; error: { message: string } | null }>;
};

function clampInt(s: string | null, min: number, max: number, fallback: number): number {
  if (s == null) return fallback;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const Route = createFileRoute("/api/public/gmail-retention")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        const url = new URL(request.url);
        const pubsubKeepDays       = clampInt(url.searchParams.get("pubsub_keep_days"),        1, 3650, 30);
        const pubsubKeepErrorsDays = clampInt(url.searchParams.get("pubsub_keep_errors_days"), 1, 3650, 60);
        const pubsubLimit          = clampInt(url.searchParams.get("pubsub_limit"),            1, 50_000, 5000);
        const dlqKeepDays          = clampInt(url.searchParams.get("dlq_keep_days"),           1, 3650, 30);
        const dlqLimit             = clampInt(url.searchParams.get("dlq_limit"),               1, 10_000, 1000);

        let pubsub: CleanupPubsubResult | null = null;
        let dlq: CleanupDlqResult | null = null;
        let pubsubError: string | null = null;
        let dlqError: string | null = null;

        try {
          const r = await (supabaseAdmin as unknown as CleanupRpc).rpc("cleanup_old_pubsub_events", {
            p_keep_days: pubsubKeepDays,
            p_keep_errors_days: pubsubKeepErrorsDays,
            p_batch_limit: pubsubLimit,
          });
          if (r.error) pubsubError = r.error.message;
          else pubsub = r.data?.[0] ?? null;
        } catch (e) {
          pubsubError = (e as Error)?.message ?? String(e);
          console.error("cleanup_old_pubsub_events failed", e);
        }

        try {
          const r = await (supabaseAdmin as unknown as DlqCleanupRpc).rpc("cleanup_old_dlq_jobs", {
            p_keep_days: dlqKeepDays,
            p_batch_limit: dlqLimit,
          });
          if (r.error) dlqError = r.error.message;
          else dlq = r.data?.[0] ?? null;
        } catch (e) {
          dlqError = (e as Error)?.message ?? String(e);
          console.error("cleanup_old_dlq_jobs failed", e);
        }

        // Single audit row per retention tick. Tagged so it's filterable
        // out of the activity feed if it gets noisy.
        try {
          await supabaseAdmin.from("pubsub_events").insert({
            event_type: "retention",
            details: `pubsub: deleted=${pubsub?.deleted ?? "?"} of ${pubsub?.total_before ?? "?"} (kept ${pubsub?.kept_errors ?? "?"} error rows); dlq: deleted=${dlq?.deleted ?? "?"} of ${dlq?.total_before ?? "?"}`,
            error: pubsubError ?? dlqError,
          });
        } catch (e) {
          console.error("retention audit log failed", e);
        }

        return Response.json({ ok: true, pubsub, dlq, pubsubError, dlqError });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
