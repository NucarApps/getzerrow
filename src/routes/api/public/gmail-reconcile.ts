// Safety-net reconciliation cron. Walks recent + cursor-paged older local
// emails for each connected Gmail account, repairing drift from Gmail's
// canonical state (missing bodies, archived/deleted upstream, etc.).
//
// Scheduled every 15 minutes via pg_cron. Accounts that look like they
// recently lost a history event (recent push but `error` set, or no
// last_history_sync_at) get a larger reconcile window to compensate.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reconcileLocalInbox, syncReadState } from "@/lib/sync.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";
import { withCronRun, logError } from "@/lib/log.server";

const DEFAULT_LIMIT = 200; // head + tail combined, walks the inbox faster
const SUSPECT_LIMIT = 500; // bigger sweep when history drift is suspected

export const Route = createFileRoute("/api/public/gmail-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        return withCronRun("gmail-reconcile", async ({ runId }) => {
          // Skip dead-OAuth accounts — every Gmail roundtrip inside reconcile
          // would throw NeedsReconnectError, producing the per-15-minute ERROR
          // stream. Mirrors the same short-circuit in gmail-poll and
          // gmail-renew-watches.
          const { data: accounts, error } = await supabaseAdmin
            .from("gmail_accounts")
            .select("id, email_address, last_history_sync_at")
            .eq("needs_reconnect", false);
          if (error) {
            logError("reconcile.accounts_query_failed", { run_id: runId }, error);
            return Response.json({ ok: false, error: error.message }, { status: 500 });
          }

          const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
          const { data: drifty } = await supabaseAdmin
            .from("pubsub_events")
            .select("email_address")
            .gte("received_at", since)
            .not("error", "is", null);
          const suspectEmails = new Set<string>(
            (drifty ?? []).map((r) => r.email_address ?? "").filter(Boolean),
          );

          const results: Array<{
            account_id: string;
            result?: unknown;
            error?: string;
            limit?: number;
          }> = [];
          for (const acc of accounts ?? []) {
            const lastSync = acc.last_history_sync_at
              ? new Date(acc.last_history_sync_at).getTime()
              : 0;
            const suspect =
              suspectEmails.has(acc.email_address) ||
              (lastSync > 0 && Date.now() - lastSync > 30 * 60 * 1000);
            const limit = suspect ? SUSPECT_LIMIT : DEFAULT_LIMIT;
            const tAcc = Date.now();
            try {
              const r = await reconcileLocalInbox(acc.id, limit);
              // Mailbox-wide read-state diff: catches read/unread changes made
              // in Gmail that the history poll missed, across all folders.
              let readState: unknown;
              try {
                readState = await syncReadState(acc.id);
              } catch (e) {
                logError("reconcile.read_state_failed", { run_id: runId, account_id: acc.id }, e);
              }
              results.push({ account_id: acc.id, result: { ...(r as object), readState }, limit });
            } catch (e) {
              const msg = (e as Error)?.message ?? String(e);
              logError(
                "reconcile.account_failed",
                {
                  run_id: runId,
                  account_id: acc.id,
                  suspect,
                  limit,
                  duration_ms: Date.now() - tAcc,
                },
                e,
              );
              results.push({ account_id: acc.id, error: msg, limit });
            }
          }

          try {
            await supabaseAdmin.from("pubsub_events").insert({
              event_type: "reconcile",
              accounts_matched: accounts?.length ?? 0,
              details: `Reconciled ${results.length} account(s); ${suspectEmails.size} suspect`,
            });
          } catch (e) {
            logError("reconcile.pubsub_log_failed", { run_id: runId }, e);
          }

          return Response.json({ ok: true, results, run_id: runId });
        });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
