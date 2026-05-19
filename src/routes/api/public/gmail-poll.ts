// Polling fallback — call from cron every 1-5 min.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory } from "@/lib/sync.server";

export const Route = createFileRoute("/api/public/gmail-poll")({
  server: {
    handlers: {
      POST: async () => {
        const { data: accounts, error } = await supabaseAdmin
          .from("gmail_accounts")
          .select("id, email_address");
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const results: Array<{ id: string; email: string; ok: boolean; error?: string }> = [];
        for (const acc of accounts ?? []) {
          try {
            const r = await syncSinceHistory(acc.id);
            results.push({ id: acc.id, email: acc.email_address, ok: true, ...r });
          } catch (e: any) {
            console.error("poll failed for", acc.email_address, e);
            results.push({ id: acc.id, email: acc.email_address, ok: false, error: e?.message ?? String(e) });
          }
        }
        return Response.json({ ok: true, count: results.length, results });
      },
      GET: async () => new Response("Use POST", { status: 405 }),
    },
  },
});
