// Daily watch renewal — bump any gmail_accounts whose watch expires within 48h.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureWatch } from "@/lib/gmail.server";

export const Route = createFileRoute("/api/public/gmail-renew-watches")({
  server: {
    handlers: {
      POST: async () => {
        const cutoff = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        const { data: accounts, error } = await supabaseAdmin
          .from("gmail_accounts")
          .select("id, email_address, watch_expiration")
          .or(`watch_expiration.is.null,watch_expiration.lt.${cutoff}`);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const results: Array<{ id: string; email: string; ok: boolean; error?: string }> = [];
        for (const acc of accounts ?? []) {
          try {
            const w = await ensureWatch(acc.id, null); // force renew
            if (w) {
              await supabaseAdmin.from("gmail_accounts").update({
                history_id: w.historyId,
                watch_expiration: new Date(parseInt(w.expiration, 10)).toISOString(),
              }).eq("id", acc.id);
            }
            results.push({ id: acc.id, email: acc.email_address, ok: true });
          } catch (e: any) {
            results.push({ id: acc.id, email: acc.email_address, ok: false, error: e?.message ?? String(e) });
          }
        }
        try {
          await supabaseAdmin.from("pubsub_events").insert({
            event_type: "watch_renew",
            accounts_matched: results.length,
            synced_count: results.filter((r) => r.ok).length,
            error: results.filter((r) => !r.ok).map((r) => `${r.email}: ${r.error}`).join("; ") || null,
          });
        } catch (e) { console.error("pubsub_events log failed", e); }
        return Response.json({ ok: true, count: results.length, results });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
