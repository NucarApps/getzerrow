// Daily watch renewal — bump any gmail_accounts whose watch expires within 48h.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureWatch } from "@/lib/gmail.server";
import { isAuthorizedCronRequest, unauthorizedResponse } from "@/lib/cron-auth.server";

export const Route = createFileRoute("/api/public/gmail-renew-watches")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!(await isAuthorizedCronRequest(request))) return unauthorizedResponse();
        const cutoff = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        const { data: accounts, error } = await supabaseAdmin
          .from("gmail_accounts")
          .select("id, email_address, watch_expiration")
          .or(`watch_expiration.is.null,watch_expiration.lt.${cutoff}`);
        if (error) {
          console.error("renew-watches: query failed", error);
          return Response.json({ ok: false, error: "Query failed" }, { status: 500 });
        }

        let ok = 0;
        let failed = 0;
        const errorSummaries: string[] = [];
        for (const acc of accounts ?? []) {
          try {
            const w = await ensureWatch(acc.id, null); // force renew
            if (w) {
              await supabaseAdmin.from("gmail_accounts").update({
                history_id: w.historyId,
                watch_expiration: new Date(parseInt(w.expiration, 10)).toISOString(),
              }).eq("id", acc.id);
            }
            ok++;
          } catch (e: unknown) {
            const msg = (e as Error)?.message ?? String(e);
            console.error("renew failed for", acc.email_address, msg);
            failed++;
            if (errorSummaries.length < 5) errorSummaries.push(msg);
          }
        }
        try {
          await supabaseAdmin.from("pubsub_events").insert({
            event_type: "watch_renew",
            accounts_matched: ok + failed,
            synced_count: ok,
            error: errorSummaries.join("; ") || null,
          });
        } catch (e) { console.error("pubsub_events log failed", e); }
        return Response.json({ ok: true, count: ok + failed, succeeded: ok, failed });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
