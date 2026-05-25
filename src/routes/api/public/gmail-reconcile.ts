// Safety-net reconciliation cron. Walks recent + cursor-paged older local
// emails for each connected Gmail account, repairing drift from Gmail's
// canonical state (missing bodies, archived/deleted upstream, etc.).
//
// Scheduled every 15 minutes via pg_cron. Accounts that look like they
// recently lost a history event (recent push but `error` set, or no
// last_history_sync_at) get a larger reconcile window to compensate.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reconcileLocalInbox } from "@/lib/sync.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";

const DEFAULT_LIMIT = 200; // head + tail combined, walks the inbox faster
const SUSPECT_LIMIT = 500; // bigger sweep when history drift is suspected

export const Route = createFileRoute("/api/public/gmail-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();

        const { data: accounts, error } = await supabaseAdmin
          .from("gmail_accounts")
          .select("id, email_address, last_history_sync_at");
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        // Accounts that received a push event with an error in the last hour
        // — likely have drift the history-diff path couldn't process — get
        // the larger window so we converge faster on the canonical state.
        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: drifty } = await supabaseAdmin
          .from("pubsub_events")
          .select("email_address")
          .gte("received_at", since)
          .not("error", "is", null);
        const suspectEmails = new Set<string>(
          (drifty ?? []).map((r) => r.email_address ?? "").filter(Boolean),
        );

        const results: Array<{ account_id: string; result?: unknown; error?: string; limit?: number }> = [];
        for (const acc of accounts ?? []) {
          const lastSync = acc.last_history_sync_at
            ? new Date(acc.last_history_sync_at).getTime()
            : 0;
          const suspect =
            suspectEmails.has(acc.email_address) ||
            // Or the account hasn't synced in 30 minutes — also suspect.
            (lastSync > 0 && Date.now() - lastSync > 30 * 60 * 1000);
          const limit = suspect ? SUSPECT_LIMIT : DEFAULT_LIMIT;
          try {
            const r = await reconcileLocalInbox(acc.id, limit);
            // Use account_id (UUID) in the response, not email — operators
            // can map id → email via the accounts table if they need to,
            // and the cron response shouldn't expose PII to whoever reads
            // logs of the cron output.
            results.push({ account_id: acc.id, result: r, limit });
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            console.error("reconcile failed for", { account_id: acc.id, err: (e as Error)?.message });
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
          console.error("pubsub_events reconcile log failed", e);
        }

        return Response.json({ ok: true, results });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
