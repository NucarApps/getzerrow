// Gmail Pub/Sub push webhook. Logs every incoming envelope (including the
// decoded payload and Pub/Sub message metadata) so the Settings activity
// panel can show exactly why a push didn't lead to a sync.
//
// Synthetic test requests from the app's "Test webhook" buttons set the
// `x-zerrow-test: 1` header so they are logged as `webhook_test` instead
// of `push` / `push_empty` and do NOT pollute real Google push diagnostics.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { syncSinceHistory } from "@/lib/sync.server";

export const Route = createFileRoute("/api/public/gmail-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const isTest = request.headers.get("x-zerrow-test") === "1";
        let emailAddress: string | null = null;
        let historyId: string | null = null;
        let accountsMatched = 0;
        let enqueuedCount = 0;
        let errorMsg: string | null = null;
        let messageId: string | null = null;
        let publishTime: string | null = null;
        let subscription: string | null = null;
        let payload: unknown = null;
        let details: string | null = null;
        let hadData = false;
        try {
          const body = await request.json();
          messageId = body?.message?.messageId ?? body?.message?.message_id ?? null;
          publishTime = body?.message?.publishTime ?? body?.message?.publish_time ?? null;
          subscription = body?.subscription ?? null;
          const dataB64 = body?.message?.data;
          if (!dataB64) {
            details = "Pub/Sub envelope had no message.data field";
            payload = body ?? null;
          } else {
            hadData = true;
            try {
              payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf-8"));
            } catch (decodeErr) {
              details = `Failed to decode message.data: ${(decodeErr as Error).message}`;
              payload = { raw: dataB64 };
            }
            const decoded = (payload ?? {}) as { emailAddress?: string; historyId?: number | string };
            emailAddress = decoded.emailAddress ?? null;
            historyId = decoded.historyId != null ? String(decoded.historyId) : null;

            if (!emailAddress) {
              details = details ?? "Decoded payload had no emailAddress field";
            } else {
              const { data: accounts } = await supabaseAdmin
                .from("gmail_accounts")
                .select("id, email_address")
                .eq("email_address", emailAddress);
              accountsMatched = accounts?.length ?? 0;
              if (accountsMatched === 0) {
                details = `No gmail_accounts row matches "${emailAddress}" — watch was probably created against a different connected account.`;
              }
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
            }
          }
        } catch (e: unknown) {
          const err = e as Error;
          console.error("webhook error", err);
          errorMsg = err?.message ?? String(e);
        } finally {
          try {
            // Single row per request. Synthetic tests are tagged so they
            // can be filtered out of real push stats.
            const event_type = isTest
              ? "webhook_test"
              : hadData
              ? "push"
              : "push_empty";
            await supabaseAdmin.from("pubsub_events").insert({
              event_type,
              email_address: emailAddress,
              history_id: historyId,
              accounts_matched: hadData ? accountsMatched : null,
              synced_count: hadData ? enqueuedCount : null,
              error: errorMsg,
              message_id: messageId,
              publish_time: publishTime,
              subscription,
              payload: (payload ?? null) as never,
              details: isTest
                ? `App-side webhook test — ${details ?? (hadData && accountsMatched > 0 ? "matched account and ran sync" : "synthetic envelope")}`
                : details,
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
