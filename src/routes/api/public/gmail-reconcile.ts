// Safety-net reconciliation cron. Walks the most recent local emails for each
// connected Gmail account and repairs anything that drifted from Gmail's
// canonical state (missing bodies, archived/deleted upstream, etc.).
// Scheduled every 15 minutes via pg_cron.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reconcileLocalInbox } from "@/lib/sync.server";
import { isAuthorizedCron, unauthorizedResponse } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/gmail-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthorizedCron(request)) return unauthorizedResponse();

        const { data: accounts, error } = await supabaseAdmin
          .from("gmail_accounts")
          .select("id, email_address");
        if (error) {
          return Response.json({ ok: false, error: error.message }, { status: 500 });
        }

        const results: Array<{ account: string; result?: unknown; error?: string }> = [];
        for (const acc of accounts ?? []) {
          try {
            const r = await reconcileLocalInbox(acc.id, 100);
            results.push({ account: acc.email_address, result: r });
          } catch (e) {
            const msg = (e as Error)?.message ?? String(e);
            console.error("reconcile failed for", acc.email_address, e);
            results.push({ account: acc.email_address, error: msg });
          }
        }

        try {
          await supabaseAdmin.from("pubsub_events").insert({
            event_type: "reconcile",
            accounts_matched: accounts?.length ?? 0,
            details: `Reconciled ${results.length} account(s)`,
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
