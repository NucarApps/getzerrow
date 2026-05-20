// Gmail Pub/Sub push webhook. Acks within ~1s by enqueuing message jobs
// rather than processing inline. The history fetch is still synchronous,
// but each message goes onto the durable queue and is processed by
// /api/public/gmail-process-jobs with retries.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory } from "@/lib/sync.server";

export const Route = createFileRoute("/api/public/gmail-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let emailAddress: string | null = null;
        let historyId: string | null = null;
        let accountsMatched = 0;
        let enqueuedCount = 0;
        let errorMsg: string | null = null;
        try {
          const body = await request.json();
          const dataB64 = body?.message?.data;
          if (!dataB64) {
            await supabaseAdmin.from("pubsub_events").insert({ event_type: "push_empty" });
            return new Response("ok", { status: 200 });
          }
          const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf-8")) as {
            emailAddress: string;
            historyId: number | string;
          };
          emailAddress = decoded.emailAddress ?? null;
          historyId = decoded.historyId != null ? String(decoded.historyId) : null;
          const { data: accounts } = await supabaseAdmin
            .from("gmail_accounts")
            .select("id")
            .eq("email_address", decoded.emailAddress);
          accountsMatched = accounts?.length ?? 0;
          for (const acc of accounts ?? []) {
            try {
              const r = await syncSinceHistory(acc.id);
              if (r && typeof (r as { synced?: number }).synced === "number") {
                enqueuedCount += (r as { synced: number }).synced;
              }
            } catch (e) {
              console.error("sync failed for", acc.id, e);
              errorMsg = (e as Error)?.message ?? String(e);
            }
          }
        } catch (e: unknown) {
          const err = e as Error;
          console.error("webhook error", err);
          errorMsg = err?.message ?? String(e);
        } finally {
          try {
            await supabaseAdmin.from("pubsub_events").insert({
              event_type: "push",
              email_address: emailAddress,
              history_id: historyId,
              accounts_matched: accountsMatched,
              synced_count: enqueuedCount,
              error: errorMsg,
            });
          } catch (logErr) {
            console.error("pubsub_events log failed", logErr);
          }
        }
        return new Response("ok", { status: 200 });
      },
    },
  },
});
